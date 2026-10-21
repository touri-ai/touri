import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createRuntimePersistence } from "../../src/runtime/persistence"

test("runtime persistence restores the person who requested a run", () => {
  const database = new Database(":memory:")
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL, provider TEXT NOT NULL,
      trigger TEXT NOT NULL, request_message_id TEXT, reply_message_id TEXT, external_turn_id TEXT,
      status TEXT NOT NULL, error_class TEXT, error_message TEXT, usage_json TEXT, routine_run_id TEXT,
      queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, provider_started_at INTEGER,
      requester_person_id TEXT
    );
  `)
  try {
    const persistence = createRuntimePersistence({ database })
    expect(
      persistence.saveRun({
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
      }),
    ).toBe(true)
    expect(persistence.getRun("run-1")?.requesterPersonId).toBe("ana")
  } finally {
    database.close()
  }
})
