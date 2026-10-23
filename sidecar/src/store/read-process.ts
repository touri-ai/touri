import { constants, Database, type SQLQueryBindings } from "bun:sqlite"
import { getMessageFromRow } from "./message-row"
import type { MessageReferences } from "./reader"
import type { RawMessage } from "./workspace-activity"

type ReadInput = {
  filename: string
  messages: boolean
  query: { sql: string; bindings: SQLQueryBindings[]; activeLeafId?: string | null; reverse?: boolean }
}

/** Private stdin protocol; this process never starts a server or loads user configuration. */
export const runStoreRead = async (): Promise<void> => {
  let database: Database | undefined
  try {
    const input = JSON.parse(await Bun.stdin.text()) as ReadInput
    database = new Database(input.filename, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW)
    database.exec("PRAGMA busy_timeout = 0; PRAGMA query_only = ON; PRAGMA cache_size = -8192")
    const statement = database.query(input.query.sql)
    await writeReply(new Uint8Array([82]))
    if (!input.messages) {
      for (const row of statement.iterate(...input.query.bindings)) await writeReply(`${JSON.stringify(row)}\n`)
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

const writeReply = (bytes: string | Uint8Array): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
  })

if (import.meta.main) await runStoreRead()
