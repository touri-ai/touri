import { Database, SQLiteError } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openAuthDatabase, openAuthStore } from "../../src/cli/auth/store"
import { prepareDatabaseFile } from "../../src/kernel/files"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const fixture = async (mode: "exclusive" | "reserved" | "wal" = "exclusive") => {
  const root = mkdtempSync(join(tmpdir(), "touri-busy-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, "auth.db")
  const store = await openAuthStore({ filename })
  await store.createPairingCode()
  await store.close()
  const database = new Database(filename)
  cleanups.push(() => database.close())
  if (mode !== "wal") database.exec("PRAGMA journal_mode = DELETE")
  database.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE" : "BEGIN IMMEDIATE")
  database.exec("UPDATE pairing_codes SET created_at = created_at + 1")
  return { root, database }
}

const start = (args: Array<string>) => {
  const child = Bun.spawn({ cmd: [process.execPath, ...args], stdout: "pipe", stderr: "pipe" })
  cleanups.push(async () => {
    child.kill()
    await child.exited
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  let stdout = ""
  const ready = (async () => {
    while (!stdout.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += new TextDecoder().decode(chunk.value)
    }
    return stdout
  })()
  const result = (async () => {
    await ready
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += new TextDecoder().decode(chunk.value)
    }
    return { stdout, stderr: await stderr, code: await child.exited }
  })()
  return { child, ready, result }
}

const cli = (root: string, ...args: Array<string>) =>
  start([join(import.meta.dir, "../../src/cli/main.ts"), ...args, "--data-dir", root])

test("the authentication database retains FULL commit durability", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-auth-durability-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, "auth.db")
  const databasePath = prepareDatabaseFile({ root, path: filename })
  const database = openAuthDatabase(databasePath)
  cleanups.push(() => database.close())

  expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  expect(database.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 })
})

for (const mode of ["exclusive", "reserved"] as const) {
  test(`status waits for the ${mode} startup lock and reads auth counts after it is released`, async () => {
    const { root, database } = await fixture(mode)
    const command = cli(root, "status")
    expect(await command.ready).toContain("touri ")
    await Bun.sleep(200)
    expect(command.child.exitCode).toBeNull()
    database.exec("COMMIT")
    const result = await command.result
    expect(result.code).toBe(3)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("paired devices: 0")
    expect(result.stdout).toContain("pending pairing codes: 1")
  })
}

test("status can read while the server holds an uncommitted WAL write transaction", async () => {
  const { root } = await fixture("wal")
  const result = await cli(root, "status").result
  expect(result.code).toBe(3)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("paired devices: 0")
  expect(result.stdout).toContain("pending pairing codes: 1")
})

for (const [name, mode] of [
  ["status", "reserved"],
  ["devices", "exclusive"],
  ["pair", "exclusive"],
  ["pair", "wal"],
] as const) {
  test(`${name} fails cleanly within a bounded time when the ${mode} lock persists`, async () => {
    const { root } = await fixture(mode)
    const startedAt = performance.now()
    const result = await cli(root, name).result
    const elapsed = performance.now() - startedAt
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("Server may still be starting: database is busy. Try again in a few seconds.\n")
    expect(result.stdout).not.toContain("Pairing code:")
    expect(result.stdout).not.toContain("paired devices:")
    expect(elapsed).toBeGreaterThanOrEqual(4500)
    expect(elapsed).toBeLessThan(10_000)
  }, 15_000)
}

for (const [code, errno] of [
  ["SQLITE_BUSY", 5],
  ["SQLITE_BUSY_RECOVERY", 261],
] as const) {
  test(`auth store retries ${code} when SQLite returns before its busy timeout`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-recovery-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const error = Object.assign(Object.create(SQLiteError.prototype), {
      name: "SQLiteError",
      code,
      errno,
      message: "database is locked",
    })
    const exec = Database.prototype.exec
    let failures = 0
    const intercepted = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database,
      sql,
      ...bindings
    ) {
      if (sql.includes("journal_mode = WAL") && failures++ < 2) throw error
      return exec.call(this, sql, ...bindings)
    })
    try {
      const filename = join(root, "auth.db")
      const databasePath = prepareDatabaseFile({ root, path: filename })
      const database = openAuthDatabase(databasePath)
      cleanups.push(() => database.close())
      expect(failures).toBe(3)
      const store = await openAuthStore({ filename })
      cleanups.push(() => store.close())
      expect((await store.createPairingCode()).success).toBe(true)
      expect(store.pendingCodeCount()).toBe(1)
    } finally {
      intercepted.mockRestore()
    }
  })
}

test("kernel database open waits before switching to WAL", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-kernel-busy-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, "touri.db")
  const database = new Database(filename)
  cleanups.push(() => database.close())
  database.exec("CREATE TABLE startup (id INTEGER); BEGIN EXCLUSIVE; INSERT INTO startup VALUES (1)")
  const command = start([
    "--eval",
    `import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "../../src/kernel/db.ts"))};
console.log("opening");
const database = openDatabase({ filename: ${JSON.stringify(filename)} });
console.log(JSON.stringify(database.query("PRAGMA busy_timeout").get()));
database.close();`,
  ])
  expect(await command.ready).toContain("opening\n")
  await Bun.sleep(200)
  expect(command.child.exitCode).toBeNull()
  database.exec("COMMIT")
  const result = await command.result
  expect(result.code).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain('"timeout":5000')
})
