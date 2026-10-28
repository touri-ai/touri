import { Database } from "bun:sqlite"
import { expect, mock, test } from "bun:test"
import { createBackgroundTask, yieldBackground } from "../../src/kernel/background-task"
import { onDatabaseShutdown, stopDatabaseTasks } from "../../src/kernel/database-lifecycle"

test("store close drains all registered producers even when one shutdown fails", async () => {
  const database = new Database(":memory:")
  const release = Promise.withResolvers<void>()
  const closed = mock(() => {})
  const task = createBackgroundTask("import_staging_expiry", async () => {
    await release.promise
    database.query("SELECT 1").get()
  })
  const running = task.run()
  onDatabaseShutdown(database, () => {
    throw new Error("synthetic shutdown failure")
  })
  onDatabaseShutdown(database, task.dispose)

  const closing = stopDatabaseTasks(database)
  const stopping = closing.catch(closed)
  await yieldBackground()
  const closedBeforeRelease = closed.mock.calls.length
  release.resolve()
  await stopping
  await running
  database.close()

  expect(closedBeforeRelease).toBe(0)
  expect(closing).toBe(stopDatabaseTasks(database))
  expect(closed).toHaveBeenCalledTimes(1)
  expect(() => onDatabaseShutdown(database, () => {})).toThrow("DATABASE_CLOSING")
})
