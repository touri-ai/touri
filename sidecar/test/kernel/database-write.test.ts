import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { onDatabaseCommit, writeDatabaseAsync } from "../../src/kernel/database-write"

const databases = new Set<Database>()
afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("an uncontended write delivers its commit before returning control", async () => {
  const database = getDatabase()
  const delivered = new Set<string>()

  const writing = writeDatabaseAsync(database, () => {
    database.exec("INSERT INTO writes VALUES (1)")
    onDatabaseCommit(database, () => delivered.add("committed"))
    return "saved"
  })

  expect(delivered.has("committed")).toBe(true)
  expect(database.inTransaction).toBe(false)
  expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
  expect(await writing).toBe("saved")
})

test("a busy error from commit delivery cannot replay a committed write", async () => {
  const database = getDatabase()
  const deliveryError = Object.assign(new Error("synthetic delivery failure"), { code: "SQLITE_BUSY" })

  const writing = writeDatabaseAsync(database, () => {
    database.exec("INSERT INTO writes VALUES (1)")
    onDatabaseCommit(database, () => {
      throw deliveryError
    })
  })

  await expect(writing).rejects.toBe(deliveryError)
  expect(database.query("SELECT count(*) AS count FROM writes").get()).toEqual({ count: 1 })
  expect(database.inTransaction).toBe(false)
  expect(database.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
})

const getDatabase = () => {
  const database = new Database(":memory:")
  databases.add(database)
  database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE writes (value INTEGER)")
  return database
}
