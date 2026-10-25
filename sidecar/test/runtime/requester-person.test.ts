import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createRuntimePersistence } from "../../src/runtime/persistence"

const cleanups = new Set<() => void>()

afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("runtime persistence restores the person who requested a run", () => {
  const database = getDatabase()
  const writer = createRuntimePersistence({ database })

  const saved = writer.saveRun({
    id: "run-1",
    threadId: "channel-bot-session",
    botId: "bot-1",
    provider: "codex",
    trigger: "user",
    requestMessageId: "message-1",
    replyMessageId: null,
    externalTurnId: null,
    status: "queued",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: null,
    finishedAt: null,
    requesterPersonId: "ana",
  })
  const reader = createRuntimePersistence({ database })
  const restored = reader.getRun("run-1")

  expect(saved).toBe(true)
  expect(restored?.requesterPersonId).toBe("ana")
})

const getDatabase = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-requester-person-"))
  const database = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(() => {
    database.close()
    rmSync(root, { recursive: true, force: true })
  })
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot-1','Demo','codex','/tmp/demo-bot',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at)
      VALUES ('channel-bot-session','bot-1','Demo conversation',1,1);
  `)

  return database
}
