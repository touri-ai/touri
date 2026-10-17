import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { compactTranscript } from "../../src/kernel/transcript-storage"

test("retention drains both journals in bounded batches and advances only committed floors", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-compaction-budget-"))
  const database = openDatabase({ filename: join(root, "touri.db") })
  try {
    database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('bot','Bot','codex','/tmp/bot',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at,updated_seq)
      VALUES ('thread','bot','Chat',1,1,1000);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
        INSERT INTO transcript_entries(thread_id,seq,generation,event_json,at)
        SELECT 'thread',x,1,'{"type":"fixture.event"}',1 FROM n;
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
        INSERT INTO ui_event_log(at,event_json) SELECT 1,'{"type":"fixture.event"}' FROM n;
      UPDATE schema_meta SET value='1000' WHERE key='transcript_event_checkpoint';`)
    const count = (table: "transcript_entries" | "ui_event_log") =>
      (database.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    let more = true
    let batches = 0
    while (more && batches < 100) {
      const beforeTranscript = count("transcript_entries")
      const beforeEvents = count("ui_event_log")
      more = compactTranscript({ database, events: 0, entriesPerThread: 0, maxAgeMs: 0, now: 2 })
      const deletedTranscript = beforeTranscript - count("transcript_entries")
      const deletedEvents = beforeEvents - count("ui_event_log")
      expect(deletedTranscript).toBeLessThanOrEqual(256)
      expect(deletedEvents).toBeLessThanOrEqual(256)
      if (beforeTranscript + beforeEvents > 0) expect(deletedTranscript + deletedEvents).toBeGreaterThan(0)
      else expect(more).toBe(false)
      if (batches === 0) {
        expect(more).toBe(true)
        expect(count("transcript_entries")).toBeGreaterThanOrEqual(744)
        expect(count("ui_event_log")).toBeGreaterThanOrEqual(744)
      }
      expect(database.query("SELECT through_seq FROM transcript_retention WHERE thread_id='thread'").get()).toEqual({
        through_seq: 1000 - count("transcript_entries"),
      })
      expect(database.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get()).toEqual({
        value: String(1000 - count("ui_event_log")),
      })
      expect(database.query("SELECT delete_before_id,ui_delete_before_seq FROM transcript_maintenance").get()).toEqual({
        delete_before_id: 0,
        ui_delete_before_seq: 0,
      })
      batches++
    }
    expect(more).toBe(false)
    expect(batches).toBeGreaterThan(1)
    expect(count("transcript_entries")).toBe(0)
    expect(count("ui_event_log")).toBe(0)
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
