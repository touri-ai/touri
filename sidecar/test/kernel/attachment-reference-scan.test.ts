import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AttachmentReferenceScanDeferred,
  createAttachmentReferenceScan,
} from "../../src/kernel/attachment-reference-scan"
import { openDatabase } from "../../src/kernel/db"
import { createPerformanceStageTracker } from "../../src/kernel/performance"

const cleanups = new Set<() => void>()
afterEach(() => {
  // Reverse only the cleanup snapshot so dependent resources close first.
  Array.from(cleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  cleanups.clear()
})

test("a worker deadline is a deferral and terminates the pending scan", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-reference-deadline-"))
  cleanups.add(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const database = openDatabase({ filename: join(root, "touri.db") })
  cleanups.add(() => {
    database.close()
  })
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Synthetic','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Synthetic',1,1);
    INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at)
      VALUES ('m','t','user','text','Synthetic',1,1);
  `)
  const scan = createAttachmentReferenceScan(database, undefined, undefined, () => new Promise(() => {}), 50)
  cleanups.add(scan.dispose)

  const pending = scan.start()

  await expect(pending).rejects.toBeInstanceOf(AttachmentReferenceScanDeferred)
})

test("in-memory reference reads happen once across multiple candidate pages", async () => {
  const database = new Database(":memory:")
  cleanups.add(() => {
    database.close()
  })
  database.exec(`
    CREATE TABLE messages(parts_json TEXT);
    CREATE TABLE tool_resolutions(part_json TEXT);
    CREATE TABLE transcript_entries(id INTEGER PRIMARY KEY, event_json TEXT);
    CREATE TABLE ui_event_log(seq INTEGER PRIMARY KEY, event_json TEXT);
    CREATE TABLE send_journal(request_json TEXT);
    INSERT INTO messages(parts_json) VALUES ('{"attachmentId":"shared"}');
  `)
  const stages = createPerformanceStageTracker(() => 0)
  const scan = createAttachmentReferenceScan(database, stages.run)
  cleanups.add(scan.dispose)
  await scan.start()
  const before = stages.snapshot()

  const first = await scan.getUnreferenced(["shared", "orphan-a"])
  const second = await scan.getUnreferenced(["shared", "orphan-b"])

  expect(first).toEqual(new Set(["orphan-a"]))
  expect(second).toEqual(new Set(["orphan-b"]))
  expect(stages.snapshot()).toEqual(before)
})
