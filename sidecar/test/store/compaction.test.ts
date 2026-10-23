import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { prepareCompactedStore } from "../../../scripts/compact-store"

// This registry owns only fixture resources and closes connections before removing directories.
const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("online compaction preserves the WAL snapshot, source and private destination", async () => {
  const { source, filename, destination } = await getFixture()
  const before = await stat(filename)
  const beforeMode = source.query("PRAGMA auto_vacuum").get()

  await prepareCompactedStore(filename, destination)
  const compacted = new Database(destination)
  cleanups.add(() => compacted.close())
  const after = await stat(destination)
  source.exec("INSERT INTO fixture VALUES ('after-copy','still writable')")

  expect(compacted.query("SELECT id,payload FROM fixture").all()).toEqual([{ id: "keep", payload: "WAL value" }])
  expect(compacted.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  expect(compacted.query("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 })
  expect(source.query("PRAGMA auto_vacuum").get()).toEqual(beforeMode)
  expect((await stat(filename)).size).toBe(before.size)
  expect(after.size).toBeLessThan(before.size / 10)
  if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600)
  expect(source.query("SELECT count(*) AS n FROM fixture").get()).toEqual({ n: 2 })
})

test("compaction refuses an existing or symlink destination without changing it", async () => {
  const { filename, destination } = await getFixture()
  await Bun.write(destination, "fixture existing backup")

  await expect(prepareCompactedStore(filename, destination)).rejects.toThrow()
  expect(await readFile(destination, "utf8")).toBe("fixture existing backup")
  await symlink(destination, `${destination}.link`)
  await expect(prepareCompactedStore(filename, `${destination}.link`)).rejects.toThrow()
  expect(await readFile(destination, "utf8")).toBe("fixture existing backup")
})

test("failed compaction removes only its own incomplete output", async () => {
  const { filename, destination } = await getFixture()
  const invalid = `${filename}.invalid`
  await Bun.write(invalid, "fixture invalid database")

  await expect(prepareCompactedStore(invalid, destination)).rejects.toThrow()

  expect(await Bun.file(destination).exists()).toBe(false)
  expect(
    (await readdir(dirname(destination))).filter((name) => name.startsWith(`${basename(destination)}.pending-`)),
  ).toEqual([])
  expect(await Bun.file(invalid).text()).toBe("fixture invalid database")
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-compact-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const destination = join(root, "compacted.db")
  const source = new Database(filename)
  cleanups.add(() => source.close())
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE fixture(id TEXT PRIMARY KEY,payload TEXT);
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<512)
    INSERT INTO fixture SELECT x,zeroblob(8192) FROM n;
    PRAGMA wal_checkpoint(TRUNCATE);
    DELETE FROM fixture;
    INSERT INTO fixture VALUES('keep','WAL value');`)

  return { source, filename, destination }
}
