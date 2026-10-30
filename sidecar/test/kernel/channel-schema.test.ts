import { afterEach, expect, test } from "bun:test"
import { applyChannelSchema } from "../../src/kernel/channel-schema"
import { testKernel } from "./test-kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("channel schema upgrades preserve read checkpoints and both partial indexes idempotently", () => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  const database = fixture.db
  database.exec(`
    DROP INDEX threads_channel_created;
    DELETE FROM schema_meta WHERE key = 'channel_main_index_version';
    UPDATE schema_meta SET value = '123' WHERE key = 'channel_reads_since';
  `)

  applyChannelSchema(database)
  const schema = database.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()
  applyChannelSchema(database)

  expect(database.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema)
  expect(database.query("SELECT value FROM schema_meta WHERE key = 'channel_reads_since'").all()).toEqual([
    { value: "123" },
  ])
  expect(database.query("SELECT value FROM schema_meta WHERE key = 'channel_main_index_version'").all()).toEqual([
    { value: "1" },
  ])
  expect(
    database
      .query(
        "SELECT name, sql FROM sqlite_master WHERE name IN ('threads_channel_created', 'threads_channel_updated') ORDER BY name",
      )
      .all(),
  ).toEqual([
    {
      name: "threads_channel_created",
      sql: "CREATE INDEX threads_channel_created ON threads(group_id, created_at, id) WHERE group_thread_id IS NULL AND archived_at IS NULL",
    },
    {
      name: "threads_channel_updated",
      sql: "CREATE INDEX threads_channel_updated ON threads(group_id, updated_at DESC)\n  WHERE group_thread_id IS NULL AND archived_at IS NULL",
    },
  ])
})
