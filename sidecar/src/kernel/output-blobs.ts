import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import type { MessagePart, RouteResponse, ToolCallPart, UiEvent } from "@touri/contracts"
import { privateFileExistsAsync, writePrivateFileAsync } from "./async-files"
import { writeDatabaseAsync } from "./database-write"
import { assertPrivateFile, atomicWriteFile, openWorkspaceDirectory, openWorkspaceEntry } from "./files"

export const OUTPUT_BLOB_THRESHOLD = 8 * 1024
export const OUTPUT_INLINE_BUDGET_BYTES = 64 * 1024
export const OUTPUT_BLOB_PREVIEW_BYTES = 1024
export const OUTPUT_BLOB_READ_BYTES = 64 * 1024
export const OUTPUT_BLOB_ORIGIN = "touri:tool-output"

// The supervisor already keeps the complete redacted process log in its file.
// The replay journal only needs a bounded window, including for a single long line.
export const boundedProcessLog = (event: Extract<UiEvent, { type: "process.log" }>): typeof event => {
  let remaining = OUTPUT_INLINE_BUDGET_BYTES
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

// Do not split a multibyte character between a preview or two output pages.
const utf8End = (bytes: Buffer): number => {
  let lead = bytes.length - 1
  while (lead >= 0 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return bytes.length
  const first = bytes[lead] ?? 0
  const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
  return bytes.length - lead < width ? lead : bytes.length
}

const outputPreview = (output: string, tail: boolean): string => {
  const bytes = Buffer.from(output)
  if (tail) {
    let start = Math.max(0, bytes.length - OUTPUT_BLOB_PREVIEW_BYTES)
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
    return bytes.subarray(start).toString("utf8")
  }
  const head = bytes.subarray(0, OUTPUT_BLOB_PREVIEW_BYTES)
  return head.subarray(0, utf8End(head)).toString("utf8")
}

const completed = (part: Extract<MessagePart, { callId: string }>): boolean => {
  if (part.resolution === "running") return false
  if (part.resolution) return true
  if (part.type === "tool_call") return part.ok !== null
  if (part.type === "command") return part.exitCode !== null
  return part.diff !== null
}

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

type ExternalizationOptions = {
  database: Database
  appData: string
  parts: MessagePart[]
  inlineBudgetBytes?: number
  reservedBytes?: number
}

export type OutputBlobWrite = { id: string; path: string; content: string; bytes: number }
export type OutputBlobAttachment = { id: string; path: string; bytes: number; originPath: string }
type ExternalizationPlan = { parts: MessagePart[]; writes: OutputBlobWrite[]; attachments: OutputBlobWrite[] }

const planExternalizedParts = ({
  database,
  appData,
  parts,
  inlineBudgetBytes = OUTPUT_INLINE_BUDGET_BYTES,
  reservedBytes = 0,
}: ExternalizationOptions): ExternalizationPlan => {
  // Reserve the shared inline budget for live progress. An indivisible live
  // frame remains inline even above the budget; the writer flushes it immediately.
  const reservedLiveBytes = Math.min(
    OUTPUT_INLINE_BUDGET_BYTES,
    parts.reduce((total, part) => {
      const output = "callId" in part && !completed(part) ? partOutput(part) : null
      if (!output) return total
      return total + inlineOutputBytes(part, output)
    }, reservedBytes),
  )
  let inlineBytes = 0
  const writes = new Map<string, OutputBlobWrite>()
  const attachments = new Map<string, OutputBlobWrite>()
  const externalized = parts.map((part) => {
    if (part.type !== "tool_call" && part.type !== "command" && part.type !== "file_change") return part
    // A changing live tail must not create a new durable file on every publish.
    if (!completed(part)) return part
    const output = partOutput(part)
    if (!output) return part
    const bytes = inlineOutputBytes(part, output)
    if (
      bytes <= OUTPUT_BLOB_THRESHOLD &&
      inlineBytes + bytes <= inlineBudgetBytes - reservedLiveBytes &&
      !containsImage(output)
    ) {
      inlineBytes += bytes
      const { outputAttachmentId: _id, outputBytes: _bytes, outputPreview: _preview, ...inline } = part
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
    const blob = { id, path, content: fullOutput, bytes: fullBytes }
    attachments.set(id, blob)
    writes.set(id, blob)
    const reference = {
      outputAttachmentId: id,
      outputBytes: fullBytes,
      outputPreview: containsImage(output)
        ? ""
        : outputPreview(part.type === "tool_call" ? part.outputTail || output : output, part.type === "command"),
    }
    if (part.type === "tool_call")
      return {
        ...withoutProgressTail(part),
        ...reference,
        outputJson: null,
      }
    if (part.type === "command") return { ...part, ...reference, outputTail: "" }
    return { ...part, ...reference, diff: null }
  })
  return { parts: externalized, writes: [...writes.values()], attachments: [...attachments.values()] }
}

const insertAttachmentRows = (database: Database, attachments: OutputBlobWrite[]): void => {
  const insert = database.query(
    "INSERT OR IGNORE INTO attachments(id,path,mime,bytes,origin_path,created_at) VALUES (?,?,'text/plain',?,?,?)",
  )
  attachments.forEach(({ id, path, bytes }) => {
    insert.run(id, path, bytes, OUTPUT_BLOB_ORIGIN, Date.now())
  })
}

export const planStreamMessageParts = (
  args: ExternalizationOptions,
): {
  parts: MessagePart[]
  files: OutputBlobWrite[]
  attachments: OutputBlobAttachment[]
} => {
  const plan = planExternalizedParts(args)

  return {
    parts: plan.parts,
    files: plan.writes,
    attachments: plan.attachments.map(({ id, path, bytes }) => ({ id, path, bytes, originPath: OUTPUT_BLOB_ORIGIN })),
  }
}

export const writeOutputBlobFilesAsync = async ({
  root,
  files,
}: {
  root: string
  files: OutputBlobWrite[]
}): Promise<void> => {
  const missing = await Promise.all(
    files.map(async (file) => ((await privateFileExistsAsync({ root, path: file.path })) ? null : file)),
  )
  await Promise.all(
    missing
      .filter((file): file is OutputBlobWrite => file !== null)
      .map(({ path, content }) => writePrivateFileAsync({ root, path, content })),
  )
}

/** Synchronous compatibility path for callers that cannot await output externalization. */
export const externalizeMessageParts = (args: ExternalizationOptions): MessagePart[] => {
  const plan = planExternalizedParts(args)
  plan.writes
    .filter(({ path }) => !existsSync(path))
    .forEach(({ path, content }) => {
      atomicWriteFile({ root: args.appData, path, content })
    })
  insertAttachmentRows(args.database, plan.attachments)
  return plan.parts
}

/** File creation for timer and request handlers runs on the dedicated I/O worker. */
export const externalizeMessagePartsAsync = async (args: ExternalizationOptions): Promise<MessagePart[]> => {
  const plan = planExternalizedParts(args)
  await writeOutputBlobFilesAsync({ root: args.appData, files: plan.writes })
  if (plan.attachments.length)
    await writeDatabaseAsync(args.database, () => insertAttachmentRows(args.database, plan.attachments))
  return plan.parts
}

/** Only an explicitly requested page is read, even for very large saved results. */
export const readOutputAttachment = ({
  database,
  appData,
  id,
  query,
}: {
  database: Database
  appData: string
  id: string
  query: Record<string, string>
}): RouteResponse => {
  const offset = query.offset === undefined ? 0 : /^\d+$/.test(query.offset) ? Number(query.offset) : NaN
  const limit =
    query.limit === undefined ? OUTPUT_BLOB_READ_BYTES : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4)
    return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Intervalo de saída inválido" } }
  const row = database.query("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string } | null
  if (!row) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Resultado não encontrado" } }
  let fd: number | undefined
  try {
    if (process.platform === "win32") {
      assertPrivateFile({ root: appData, path: row.path })
      fd = openSync(row.path, constants.O_RDONLY)
    } else {
      const directory = openWorkspaceDirectory({ root: appData, path: relative(appData, dirname(row.path)) })
      try {
        fd = openWorkspaceEntry(directory, basename(row.path))
      } finally {
        closeSync(directory)
      }
    }
    const info = fstatSync(fd)
    if (!info.isFile() || offset > info.size)
      return { status: 400, json: { errorCode: "INVALID_ARGS", error: "Intervalo de saída inválido" } }
    const buffer = Buffer.alloc(Math.min(limit, OUTPUT_BLOB_READ_BYTES, info.size - offset))
    let count = 0
    while (count < buffer.length) {
      const size = readSync(fd, buffer, count, buffer.length - count, offset + count)
      if (!size) break
      count += size
    }
    const bytes = buffer.subarray(0, count)
    const end = offset + count < info.size ? utf8End(bytes) : count
    return {
      status: 200,
      json: {
        text: bytes.subarray(0, end).toString("utf8"),
        offset,
        nextOffset: offset + end < info.size ? offset + end : null,
        bytes: info.size,
      },
    }
  } catch {
    return { status: 404, json: { errorCode: "NOT_FOUND", error: "Resultado não encontrado" } }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
