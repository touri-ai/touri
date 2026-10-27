import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { tryCollectOutput, withOutputPublication } from "../../src/kernel/output-publication"

const databases = new Set<Database>()
afterEach(() => {
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("a publisher waits for an already accepted removal before recreating an output", async () => {
  const database = makeDatabase()
  const removing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  // Record the order of this test's asynchronous file lifecycle.
  const completed = new Set<string>()
  const collection = tryCollectOutput(database, async () => {
    removing.resolve()
    await release.promise
    completed.add("removal")
  })
  await removing.promise
  const publication = withOutputPublication(database, async () => {
    completed.add("publication")
  })

  expect(await tryCollectOutput(database, async () => {})).toBe(false)
  release.resolve()
  await publication

  expect(await collection).toBe(true)
  expect(Array.from(completed)).toEqual(["removal", "publication"])
  expect(await tryCollectOutput(database, async () => {})).toBe(true)
})

test("a failed publication releases collection and a failed removal releases publishers", async () => {
  const database = makeDatabase()

  await expect(
    withOutputPublication(database, async () => {
      throw new Error("publication failed")
    }),
  ).rejects.toThrow("publication failed")
  await expect(
    tryCollectOutput(database, async () => {
      throw new Error("removal failed")
    }),
  ).rejects.toThrow("removal failed")

  expect(await withOutputPublication(database, async () => "recreated")).toBe("recreated")
  expect(await tryCollectOutput(database, async () => {})).toBe(true)
})

const makeDatabase = () => {
  const database = new Database(":memory:")
  databases.add(database)
  return database
}
