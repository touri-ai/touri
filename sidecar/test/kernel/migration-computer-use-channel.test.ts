import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("computer-use channel migration stores requester, controller and queue state", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-computer-use-channel-"))
  const db = openDatabase({ filename: join(root, "test.db") })
  try {
    expect(SCHEMA_VERSION).toBe(50)
    expect(db.query("SELECT value FROM schema_meta WHERE key = 'browser_channel_runs_version'").get()).toEqual({
      value: "1",
    })
    expect(db.query("SELECT name FROM pragma_table_info('runs') WHERE name = 'requester_person_id'").get()).toEqual({
      name: "requester_person_id",
    })
    expect(
      db.query("SELECT name FROM pragma_table_info('notifications') WHERE name = 'target_person_id'").get(),
    ).toEqual({ name: "target_person_id" })
    expect(db.query("PRAGMA index_list('browser_channel_runs')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_channel_runs_bot_queue" }),
        expect.objectContaining({ name: "browser_channel_runs_thread_queue" }),
        expect.objectContaining({ name: "browser_channel_runs_active_slot", unique: 1 }),
      ]),
    )
    const queuePlan = db
      .query(`EXPLAIN QUERY PLAN SELECT run_id FROM browser_channel_runs
        WHERE thread_id = ? AND bot_id = ? AND status = 'queued' ORDER BY queued_at, run_id LIMIT 20`)
      .all("channel", "bot")
    expect(JSON.stringify(queuePlan)).toContain("browser_channel_runs_thread_queue")
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
