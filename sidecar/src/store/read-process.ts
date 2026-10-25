import { constants, Database, type SQLQueryBindings } from "bun:sqlite"
import { getRefEvent } from "../kernel/event-reference"
import type { TranscriptRef } from "../kernel/transcript-events"
import { getRecoveryCandidates, type RecoveryCursor } from "../notify/recovery-candidates"
import { getMessageFromRow } from "./message-row"
import type { MessageReferences, ReadQuery } from "./reader"
import type { RawMessage } from "./workspace-activity"

type ReadInput = {
  filename: string
  messages: boolean
} & (
  | { recovery: RecoveryCursor }
  | { queries: ReadQuery[] }
  | { references: TranscriptRef[]; maxBytes?: number }
  | {
      query: {
        sql: string
        bindings: SQLQueryBindings[]
        activeLeafId?: string | null
        reverse?: boolean
        chunkedStrings?: boolean
      }
    }
)

/** Private stdin protocol; this process never starts a server or loads user configuration. */
export const runStoreRead = async (): Promise<void> => {
  let database: Database | undefined
  try {
    const input = JSON.parse(await Bun.stdin.text()) as ReadInput
    database = new Database(input.filename, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW)
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; PRAGMA cache_size = -8192")
    await writeReply(new Uint8Array([82]))
    if ("references" in input) {
      let bytes = 0
      for (const reference of input.references) {
        const serialized = JSON.stringify(getRefEvent(database, reference))
        bytes += Buffer.byteLength(serialized)
        if (input.maxBytes !== undefined && bytes > input.maxBytes) {
          await writeReply(`${JSON.stringify({ type: "transcript.resync" })}\n`)
          return
        }
        await writeReply(`${serialized}\n`)
      }
      return
    }
    if ("recovery" in input) {
      for (const candidate of getRecoveryCandidates(database, input.recovery))
        await writeReply(`${JSON.stringify(candidate)}\n`)
      return
    }
    if ("queries" in input) {
      if (input.queries.length > 8) throw new Error("STORE_READ_LIMIT")

      // One owned snapshot avoids three process launches and cross-query revision changes.
      database.exec("BEGIN")
      const writer = createFrameWriter()
      for (const [index, query] of input.queries.entries()) {
        for (const row of database.query(query.sql).iterate(...query.bindings))
          await writeRowFrames({ ...(row as Record<string, unknown>), _storeReadSet: index }, writer.write)
      }
      await writer.flush()
      return
    }
    const statement = database.query(input.query.sql)
    if (!input.messages) {
      for (const row of statement.iterate(...input.query.bindings)) {
        if (input.query.chunkedStrings) await writeRowFrames(row as Record<string, unknown>)
        else await writeReply(`${JSON.stringify(row)}\n`)
      }
      return
    }

    // Private accumulators bound peak memory; historical JSON never reaches the main loop as an object.
    const messages: string[] = []
    const references: MessageReferences[] = []
    let bytes = 0
    for (const row of statement.iterate(...input.query.bindings)) {
      const message = getMessageFromRow(row as RawMessage)
      const serialized = JSON.stringify(message)
      bytes += Buffer.byteLength(serialized)
      if (bytes > 64 * 1024 * 1024) throw new Error("STORE_READ_LIMIT")
      messages.push(serialized)
      const attachmentIds = Array.from(
        new Set(
          message.parts.flatMap((part) => {
            if (part.type === "image" || part.type === "file") return [part.attachmentId]
            return "outputAttachmentId" in part && typeof part.outputAttachmentId === "string"
              ? [part.outputAttachmentId]
              : []
          }),
        ),
      )
      if (attachmentIds.length) references.push({ threadId: message.threadId, messageId: message.id, attachmentIds })
    }
    const ordered = input.query.reverse ? messages.reverse() : messages
    const body = new TextEncoder().encode(
      `{"messages":[${ordered.join(",")}],"activeLeafId":${JSON.stringify(input.query.activeLeafId ?? null)}}`,
    )
    const referenceLines = references.map((reference) => JSON.stringify(reference))
    const header = new TextEncoder().encode(referenceLines.length ? `${referenceLines.join("\n")}\n` : "")
    if (header.byteLength > 8 * 1024 * 1024) throw new Error("STORE_READ_LIMIT")
    const prefix = new Uint8Array(4)
    new DataView(prefix.buffer).setUint32(0, header.byteLength)
    await writeReply(prefix)
    await writeReply(header)
    await writeReply(body)
  } catch {
    // Never emit paths, SQL, bindings or stored content on failure.
    process.exitCode = 1
  } finally {
    database?.close()
  }
}

const writeRowFrames = async (
  row: Record<string, unknown>,
  write: (frame: string) => Promise<void> = writeReply,
): Promise<void> => {
  const entries = Object.entries(row)
  const isLongString = (value: unknown): value is string => typeof value === "string" && value.length > 16_384
  const header = Object.fromEntries(entries.filter(([, value]) => !isLongString(value)))
  await write(`${JSON.stringify(header)}\n`)
  for (const [key, value] of entries) {
    if (!isLongString(value)) continue
    for (let offset = 0; offset < value.length; offset += 16_384)
      await write(`${JSON.stringify([key, value.slice(offset, offset + 16_384)])}\n`)
  }
  await write("null\n")
}

const createFrameWriter = () => {
  // Only this process owns the bounded frame buffer; flushing awaits pipe backpressure.
  let frames = ""
  const flush = async (): Promise<void> => {
    if (!frames) return

    const batch = frames
    frames = ""
    await writeReply(batch)
  }

  return {
    write: async (frame: string): Promise<void> => {
      frames += frame
      if (frames.length >= 16_384) await flush()
    },
    flush,
  }
}

const writeReply = (bytes: string | Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
  })

if (import.meta.main) await runStoreRead()
