import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { createStoreReader } from "../../src/store/reader"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const makeFixture = async (base = tmpdir()) => {
  const root = await mkdtemp(join(base, "touri-reader-path-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const database = openDatabase({ filename })
  cleanups.add(() => database.close())

  return { root, filename }
}

const getRows = (filename: string) => {
  const reader = createStoreReader(filename)
  cleanups.add(reader.dispose)

  return reader.getRows({ sql: "SELECT 'synthetic' AS value", bindings: [] }, new AbortController().signal)
}

test.skipIf(process.platform !== "darwin")(
  "a system temporary-directory alias remains readable with NOFOLLOW",
  async () => {
    const fixture = await makeFixture("/tmp")

    const rows = await getRows(fixture.filename)

    expect(rows).toEqual([{ value: "synthetic" }])
  },
)

test.skipIf(process.platform === "win32")("a database symlink is still refused by the read-only helper", async () => {
  const fixture = await makeFixture()
  const alias = join(fixture.root, "alias.db")
  await symlink(fixture.filename, alias)

  const rows = getRows(alias)

  await expect(rows).rejects.toThrow("STORE_READ_FAILED")
})
