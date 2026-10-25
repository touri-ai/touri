import { constants, Database, type SQLQueryBindings } from "bun:sqlite"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { prepareDatabaseFile } from "../kernel/files"
import type { BotMetadataEdit, BotMetadataStatement } from "./bot-metadata"

/** Private framed input; no listener, host capability or user-supplied executable is loaded. */
export const runBotMetadataWriter = async (): Promise<void> => {
  let database: Database | undefined
  try {
    const frames = getFrames()
    const header = await frames.next()
    if (header.done) throw new Error("Incomplete metadata")
    const { filename, token, metadata, hasInstructions } = JSON.parse(header.value) as {
      filename: string
      token: string
      metadata: BotMetadataEdit
      hasInstructions: boolean
    }
    const chunks: string[] = []
    let size = 0
    // This process owns accumulation, hashing and SQLite; none runs on the live loop.
    for await (const frame of frames) {
      const chunk: unknown = JSON.parse(frame)
      if (!hasInstructions || typeof chunk !== "string") throw new Error("Invalid metadata content")
      size += chunk.length
      if (size > 32 * 1024 * 1024) throw new Error("Metadata content exceeds limit")
      chunks.push(chunk)
    }
    const instructions = hasInstructions ? chunks.join("") : undefined
    const instructionsHash =
      instructions === undefined ? undefined : createHash("sha256").update(instructions).digest("hex")
    const databasePath = prepareDatabaseFile({ root: dirname(filename), path: filename })
    database = new Database(databasePath, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW)
    database.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL",
    )
    process.stdout.write("R")
    const connection = database
    const committed = connection
      .transaction(() => {
        const current = connection.query(metadata.select).get(metadata.botId)
        if (JSON.stringify(current) !== JSON.stringify(metadata.expected)) return undefined

        const statement = getMetadataStatement(metadata.statement, instructions, instructionsHash)
        connection.query(statement.sql).run(...statement.bindings)
        const row = connection.query(metadata.select).get(metadata.botId)
        connection
          .query(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
          )
          .run(`bot-metadata:${metadata.botId}`, JSON.stringify({ token, row }), Date.now())
        return row
      })
      .immediate()
    process.stdout.write(committed ? JSON.stringify(committed) : "C")
  } catch {
    // SQL, bindings, instructions and local paths never cross the error boundary.
    process.exitCode = 1
  } finally {
    database?.close()
  }
}

const getFrames = async function* (): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let tail = ""
  let firstFrame = true
  const reader = Bun.stdin.stream().getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    const chunk = next.value
    const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n")
    tail = lines.pop() ?? ""
    if (tail.length > (firstFrame ? 128 * 1024 * 1024 : 128 * 1024)) throw new Error("Metadata frame exceeds limit")
    for (const line of lines) {
      if (line.length > (firstFrame ? 128 * 1024 * 1024 : 128 * 1024)) throw new Error("Metadata frame exceeds limit")
      firstFrame = false
      yield line
    }
  }
  if (tail) throw new Error("Incomplete metadata frame")
}

const getMetadataStatement = (
  statement: BotMetadataStatement,
  instructions: string | undefined,
  hash: string | undefined,
): BotMetadataStatement => {
  if (instructions === undefined || hash === undefined) return statement
  const content: SQLQueryBindings[] = [instructions, hash]
  return {
    sql: statement.sql.replace("SET ", "SET instructions = ?, instructions_hash = ?, "),
    bindings: content.concat(statement.bindings),
  }
}

if (import.meta.main) await runBotMetadataWriter()
