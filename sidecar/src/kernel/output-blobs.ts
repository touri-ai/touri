import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { MessagePart, ToolCallPart, UiEvent } from "@touri/contracts"
import { atomicWriteFile } from "./files"

export const OUTPUT_BLOB_THRESHOLD = 64 * 1024
export const OUTPUT_BLOB_ORIGIN = "touri:tool-output"

// The supervisor already keeps the complete redacted process log in its file.
// The replay journal only needs a bounded window, including for a single long line.
export const boundedProcessLog = (event: Extract<UiEvent, { type: "process.log" }>): typeof event => {
  let remaining = OUTPUT_BLOB_THRESHOLD
  const lines: string[] = []
  for (let index = event.lines.length - 1; index >= 0 && remaining > 0; index--) {
    const line = event.lines[index] ?? ""
    const bytes = Buffer.from(line)
    let start = Math.max(0, bytes.length - remaining)
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
    const tail = bytes.subarray(start).toString("utf8")
    lines.unshift(tail)
    remaining -= Buffer.byteLength(tail) + 1
  }
  return { ...event, lines }
}

export const attachmentReferences = (value: unknown, ids = new Set<string>()): Set<string> => {
  if (!value || typeof value !== "object") return ids
  for (const [key, item] of Object.entries(value)) {
    if ((key === "outputAttachmentId" || key === "attachmentId") && typeof item === "string") ids.add(item)
    else if (typeof item === "object") attachmentReferences(item, ids)
  }
  return ids
}

// Keep the original provider envelope byte-for-byte in the file. This covers
// MCP/Claude image blocks and host screenshots without guessing image formats.
const containsImage = (output: string): boolean =>
  /"type"\s*:\s*"image"|data:image\/[^;]+;base64,|"(?:dataBase64|imageBase64)"\s*:/.test(output)

const withoutProgressTail = ({ outputTail: _tail, ...part }: ToolCallPart): ToolCallPart => part

const partOutput = (part: MessagePart): string | null | undefined =>
  part.type === "tool_call"
    ? part.outputJson || part.outputTail
    : part.type === "command"
      ? part.outputTail
      : part.type === "file_change"
        ? part.diff
        : null

const inlineOutputBytes = (part: MessagePart, output: string): number =>
  Buffer.byteLength(output) +
  (part.type === "tool_call" && part.outputJson && part.outputTail ? Buffer.byteLength(part.outputTail) : 0)

const runningOutput = (part: MessagePart): boolean => {
  if ("resolution" in part && part.resolution && part.resolution !== "running") return false
  return (part.type === "command" && part.exitCode === null) || (part.type === "tool_call" && part.ok === null)
}

export const externalizeMessageParts = ({
  database,
  appData,
  parts,
}: {
  database: Database
  appData: string
  parts: MessagePart[]
}): MessagePart[] => {
  // Keep live progress visible. Otherwise completed outputs fill the budget and
  // each changing progress frame creates another file instead of an inline tail.
  const reservedLiveBytes = Math.min(
    OUTPUT_BLOB_THRESHOLD,
    parts.reduce((total, part) => {
      const output = runningOutput(part) ? partOutput(part) : null
      if (!output) return total
      const bytes = inlineOutputBytes(part, output)
      return bytes <= OUTPUT_BLOB_THRESHOLD && !containsImage(output) ? total + bytes : total
    }, 0),
  )
  let inlineBytes = 0
  let liveInlineBytes = 0
  return parts.map((part) => {
    if (part.type !== "tool_call" && part.type !== "command" && part.type !== "file_change") return part
    const output = partOutput(part)
    if (!output) return part
    const bytes = inlineOutputBytes(part, output)
    const live = runningOutput(part)
    const withinBudget = live
      ? liveInlineBytes + bytes <= reservedLiveBytes
      : inlineBytes + bytes <= OUTPUT_BLOB_THRESHOLD - reservedLiveBytes
    if (withinBudget && !containsImage(output)) {
      if (live) liveInlineBytes += bytes
      else inlineBytes += bytes
      const { outputAttachmentId: _id, outputBytes: _bytes, ...inline } = part
      return inline
    }
    // A final result can include a separate command preview. Preserve both when
    // offloading instead of silently discarding the preview or leaving it unbounded.
    const fullOutput =
      part.type === "tool_call" && part.outputJson && part.outputTail
        ? JSON.stringify({ outputJson: part.outputJson, outputTail: part.outputTail })
        : output
    const fullBytes = Buffer.byteLength(fullOutput)
    const id = createHash("sha256").update(fullOutput).digest("hex")
    const existing = database.query("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string } | null
    const path = existing?.path ?? join(appData, "attachments", id.slice(0, 2), `${id}.tool-output.txt`)
    // Commit the durable file before any row/event can refer to it. An interrupted
    // transaction may leave an orphan, which the maintenance collector can remove.
    if (!existsSync(path)) atomicWriteFile({ root: appData, path, content: fullOutput })
    database
      .query(
        "INSERT OR IGNORE INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES (?,?,'text/plain',?,?,?)",
      )
      .run(id, path, fullBytes, OUTPUT_BLOB_ORIGIN, Date.now())
    const reference = { outputAttachmentId: id, outputBytes: fullBytes }
    if (part.type === "tool_call") return { ...withoutProgressTail(part), ...reference, outputJson: null }
    if (part.type === "command") return { ...part, ...reference, outputTail: "" }
    return { ...part, ...reference, diff: null }
  })
}
