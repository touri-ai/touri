/** Synthetic, provider-free data for measuring composer input and long-thread loading. */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { MessagePart } from "@touri/contracts"
import { openDatabase } from "../sidecar/src/kernel/db"
import { ensurePrivateDirectory } from "../sidecar/src/kernel/files"
import uiSeed from "../sidecar/test/fixtures/ui-seed.json"
import { createComposerPerformanceMessages } from "../ui/test/e2e/composer-performance-fixture"

const botId = "composer-performance-bot"
const threadId = "composer-performance-thread"
const provider = uiSeed.bots[0]?.provider
if (!provider) throw new Error("The UI seed must define a provider")
const worktree = resolve(import.meta.dir, "..")
const cacheRoot = join(worktree, "node_modules", ".cache")
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--data-dir" || !args[1])
  throw new Error("Usage: bun scripts/seed-composer-performance.ts --data-dir <new temporary directory>")

const dataDir = resolve(args[1])
const within = (root: string, path: string): boolean => {
  const suffix = relative(root, path)
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep)
}
const allowedRoot = within(cacheRoot, dataDir) ? cacheRoot : within("/tmp", dataDir) ? "/tmp" : null
if (!allowedRoot) throw new Error("Choose a new directory inside this worktree's node_modules/.cache or /tmp")

// Refuse symlinked destinations and populated directories rather than resetting a live database.
for (let entry = dataDir; entry !== dirname(entry); entry = dirname(entry)) {
  if (existsSync(entry) && lstatSync(entry).isSymbolicLink())
    throw new Error("The fixture data directory and its parents must not be symlinks")
}
let ancestor = dataDir
while (!existsSync(ancestor)) ancestor = dirname(ancestor)
const canonicalTarget = resolve(realpathSync(ancestor), relative(ancestor, dataDir))
if (!within(resolve(allowedRoot), canonicalTarget)) throw new Error("The fixture must stay inside its temporary root")
if (existsSync(dataDir) && readdirSync(dataDir).length)
  throw new Error("The fixture data directory must be empty; existing data is never overwritten")

ensurePrivateDirectory({ root: dataDir })
const botHome = join(dataDir, "bots", botId)
ensurePrivateDirectory({ root: dataDir, path: botHome })
const databasePath = join(dataDir, "touri.db")
const database = openDatabase({ filename: databasePath })
const messages = createComposerPerformanceMessages()
const now = Date.now()
let tools = 0

try {
  database.transaction(() => {
    database
      .query(`INSERT INTO bots (
        id, name, provider, access, approvals, home_dir, main_thread_id,
        browser_enabled, computer_use, notifications, machine, created_at, updated_at
      ) VALUES (?, 'Composer performance fixture', ?, 'read-only', 'never', ?, ?, 0, 0, 'none', 'local', ?, ?)`)
      .run(botId, provider, botHome, threadId, now, now)
    database
      .query(`INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at)
        VALUES (?, ?, 'main', 'Synthetic long conversation', ?, ?)`)
      .run(threadId, botId, now, now)

    const insertRun = database.query(`INSERT INTO runs (
      id, thread_id, bot_id, provider, trigger, request_message_id, reply_message_id,
      status, queued_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, 'import', ?, ?, 'succeeded', ?, ?, ?)`)
    const insertMessage = database.query(`INSERT INTO messages (
      id, thread_id, parent_id, role, kind, status, run_id, text, parts_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)`)
    const updateParts = database.query(
      "UPDATE messages SET parts_json = ?, updated_at = ? WHERE thread_id = ? AND id = ?",
    )
    const insertFts = database.query("INSERT INTO messages_fts (text, thread_id, message_id) VALUES (?, ?, ?)")
    const insertAudit = database.query(`INSERT INTO tool_calls (
      id, run_id, thread_id, bot_id, tool, args_json, ok, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`)
    const insertResolution = database.query(`INSERT INTO tool_resolutions (
      run_id, call_id, thread_id, part_json, resolution, resolved_at
    ) VALUES (?, ?, ?, ?, 'succeeded', ?)`)

    for (const [index, message] of messages.entries()) {
      const at = now - (messages.length - index) * 1000
      if (message.runId)
        insertRun.run(message.runId, threadId, botId, provider, message.parentId, message.id, at, at, at + 100)
      const initialParts = message.parts.filter((part) => part.type !== "tool_call")
      insertMessage.run(
        message.id,
        threadId,
        message.parentId,
        message.role,
        message.kind,
        message.runId,
        message.text,
        JSON.stringify(initialParts),
        at,
        at,
      )
      const parts: MessagePart[] = [...initialParts]
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue
        tools += 1
        parts.push(part)
        // Exercise the same durable event history as a transcript with settled tool calls.
        updateParts.run(JSON.stringify(parts), at + parts.length, threadId, message.id)
        insertAudit.run(part.callId, message.runId, threadId, botId, part.tool, part.inputJson, at)
        if (message.runId)
          insertResolution.run(message.runId, part.callId, threadId, JSON.stringify(part), at + parts.length)
      }
      insertFts.run(message.text, threadId, message.id)
    }
    database
      .query("UPDATE threads SET active_leaf_id = ?, updated_at = ? WHERE id = ?")
      .run(messages.at(-1)?.id ?? null, now, threadId)
    // All generated events already have their final projection; no startup replay is needed.
    database.exec(`UPDATE schema_meta SET value = CAST((SELECT MAX(id) FROM transcript_entries) AS TEXT)
      WHERE key = 'transcript_event_checkpoint'`)
  })()
  const { entries } = database.query("SELECT COUNT(*) AS entries FROM transcript_entries").get() as { entries: number }
  console.log(JSON.stringify({ botId, threadId, messages: messages.length, tools, entries }, null, 2))
} finally {
  database.close()
}
