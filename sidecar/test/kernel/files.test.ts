import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createKernel } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import {
  atomicAppendFile,
  atomicWriteFile,
  createAtomicWriter,
  createWorkspaceChildDirectory,
  createWorkspaceDirectory,
  ensurePrivateDirectory,
  openWorkspaceDirectory,
  prepareDatabaseFile,
  readPrivateFile,
} from "../../src/kernel/files"

const roots: Array<string> = []
const fixture = () => {
  const parent = mkdtempSync(join(tmpdir(), "touri-storage-"))
  roots.push(parent)
  const root = join(parent, "data")
  const outside = join(parent, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  return { root, outside, parent }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform === "win32")("selected folder creation uses the platform native adapter", () => {
  const { root, outside } = fixture()
  const fd = openWorkspaceDirectory({ root, path: "" })
  try {
    createWorkspaceChildDirectory(fd, "output")
    expect(statSync(join(root, "output")).isDirectory()).toBe(true)
    expect(statSync(join(root, "output")).mode & 0o777).toBe(0o700)
    expect(() => createWorkspaceChildDirectory(fd, "../outside/escape")).toThrow()
    expect(existsSync(join(outside, "escape"))).toBe(false)
  } finally {
    closeSync(fd)
  }
})

test("workspace directory creation preserves existing modes and refuses escape links", () => {
  const { root, outside } = fixture()
  chmodSync(root, 0o755)
  const identity = statSync(root)
  createWorkspaceDirectory({ root, path: "images/generated", identity })
  expect(statSync(join(root, "images/generated")).isDirectory()).toBe(true)
  expect(statSync(root).mode & 0o777).toBe(0o755)
  symlinkSync(outside, join(root, "escape"))
  expect(() => createWorkspaceDirectory({ root, path: "escape/images", identity })).toThrow()
  expect(() => createWorkspaceDirectory({ root, path: "../images", identity })).toThrow()
  expect(existsSync(join(outside, "images"))).toBe(false)
})

test("workspace directory creation refuses a replaced ancestor", () => {
  const { root } = fixture()
  const identity = statSync(root)
  renameSync(root, `${root}-original`)
  mkdirSync(root)
  expect(() => createWorkspaceDirectory({ root, path: "images", identity })).toThrow()
  expect(existsSync(join(root, "images"))).toBe(false)
})

test("atomic replacement persists file before rename and directory after rename", () => {
  const { root } = fixture()
  const path = join(root, "state.json")
  atomicWriteFile({ root, path, content: "old" })
  const stages: Array<string> = []
  const write = createAtomicWriter({
    sync: (fd) => {
      const directory = fstatSync(fd).isDirectory()
      stages.push(directory ? "directory" : "file")
      expect(readFileSync(path, "utf8")).toBe(directory ? "new" : "old")
      fsyncSync(fd)
    },
  })
  write({ root, path, content: "new" })
  expect(stages).toEqual(["file", "directory"])
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readdirSync(root)).toEqual(["state.json"])
})

test("a failed file fsync preserves the original and cleans up its temporary file", () => {
  const { root } = fixture()
  const path = join(root, "state")
  atomicWriteFile({ root, path, content: "original" })
  const write = createAtomicWriter({
    sync: () => {
      throw new Error("injected sync failure")
    },
  })
  expect(() => write({ root, path, content: "replacement" })).toThrow()
  expect(readFileSync(path, "utf8")).toBe("original")
  expect(readdirSync(root)).toEqual(["state"])
})

test("a directory fsync failure is reported after atomic publication", () => {
  const { root } = fixture()
  const path = join(root, "state")
  const write = createAtomicWriter({
    sync: (fd) => {
      if (fstatSync(fd).isDirectory()) throw new Error("directory sync failed")
      fsyncSync(fd)
    },
  })
  expect(() => write({ root, path, content: "complete" })).toThrow()
  expect(readFileSync(path, "utf8")).toBe("complete")
  expect(readdirSync(root)).toEqual(["state"])
})

test.each(["root", "ancestor", "target", "dangling"])(
  "refuses a %s symlink without touching external files",
  (kind) => {
    const { root, outside, parent } = fixture()
    const external = join(outside, "state")
    writeFileSync(external, "untouched", { mode: 0o644 })
    let storageRoot = root
    let path = join(root, "state")
    if (kind === "root") {
      storageRoot = join(parent, "linked-data")
      symlinkSync(outside, storageRoot)
      path = join(storageRoot, "state")
    } else if (kind === "ancestor") {
      symlinkSync(outside, join(root, "nested"))
      path = join(root, "nested", "deeper", "state")
    } else symlinkSync(kind === "dangling" ? join(outside, "missing") : external, path)
    expect(() => atomicWriteFile({ root: storageRoot, path, content: "bad" })).toThrow()
    expect(readFileSync(external, "utf8")).toBe("untouched")
    expect(statSync(external).mode & 0o777).toBe(0o644)
    expect(readdirSync(outside)).toEqual(["state"])
  },
)

test("refuses traversal and sibling-prefix escapes before creating directories", () => {
  const { root, outside, parent } = fixture()
  for (const path of [join(root, "..", "outside", "state"), join(parent, "data-other", "state"), `${root}/state\0x`])
    expect(() => atomicWriteFile({ root, path, content: "bad" })).toThrow()
  expect(readdirSync(outside)).toEqual([])
  expect(readdirSync(parent).sort()).toEqual(["data", "outside"])
})

test("refuses hard-linked persistent files before changing content or permissions", () => {
  const { root, outside } = fixture()
  const external = join(outside, "state")
  const path = join(root, "state")
  writeFileSync(external, "original", { mode: 0o644 })
  linkSync(external, path)
  expect(() => atomicWriteFile({ root, path, content: "bad" })).toThrow()
  expect(() => prepareDatabaseFile({ root, path })).toThrow()
  expect(readFileSync(external, "utf8")).toBe("original")
  expect(statSync(external).mode & 0o777).toBe(0o644)
})

test("a swapped ancestor never redirects a pending write through its replacement symlink", () => {
  const { root, outside } = fixture()
  const nested = join(root, "nested")
  mkdirSync(nested)
  const write = createAtomicWriter({
    sync: (fd) => {
      fsyncSync(fd)
      if (!fstatSync(fd).isDirectory()) {
        renameSync(nested, join(root, "pinned"))
        symlinkSync(outside, nested)
      }
    },
  })
  write({ root, path: join(nested, "state"), content: "safe" })
  expect(readdirSync(outside)).toEqual([])
  expect(readFileSync(join(root, "pinned", "state"), "utf8")).toBe("safe")
  expect(() => atomicWriteFile({ root, path: join(nested, "other"), content: "bad" })).toThrow()
})

test("target symlink substitution during fsync refuses publication and removes the temporary file", () => {
  const { root, outside } = fixture()
  const path = join(root, "state")
  const external = join(outside, "state")
  writeFileSync(external, "outside")
  atomicWriteFile({ root, path, content: "old" })
  const write = createAtomicWriter({
    sync: (fd) => {
      fsyncSync(fd)
      if (!fstatSync(fd).isDirectory()) {
        rmSync(path)
        symlinkSync(external, path)
      }
    },
  })
  expect(() => write({ root, path, content: "bad" })).toThrow()
  expect(readFileSync(external, "utf8")).toBe("outside")
  expect(readdirSync(root)).toEqual(["state"])
  expect(lstatSync(path).isSymbolicLink()).toBe(true)
})

test("binary files, private parents, log append and no-follow reads share the same boundary", () => {
  const { root, outside } = fixture()
  const path = join(root, "nested", "data")
  atomicWriteFile({ root, path, content: Uint8Array.from([0, 255, 42]) })
  expect(readPrivateFile({ root, path })).toEqual(Buffer.from([0, 255, 42]))
  expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700)
  const log = join(root, "log")
  atomicAppendFile({ root, path: log, content: "one\n" })
  atomicAppendFile({ root, path: log, content: "two\n" })
  expect(readPrivateFile({ root, path: log })?.toString()).toBe("one\ntwo\n")
  symlinkSync(outside, join(root, "link"))
  expect(() => ensurePrivateDirectory({ root, path: join(root, "link", "new") })).toThrow()
  expect(readdirSync(outside)).toEqual([])
})

test("bounded log snapshots retain complete recent lines and flush batches atomically", () => {
  const { root } = fixture()
  const path = join(root, "process.log")
  atomicAppendFile({ root, path, content: "primeira\nsegunda\n", maxBytes: 25 })
  atomicAppendFile({ root, path, content: "terceira\nquarta\n", maxBytes: 25 })
  expect(readPrivateFile({ root, path })?.toString()).toBe("segunda\nterceira\nquarta\n")
  expect(statSync(path).size).toBeLessThanOrEqual(25)
  atomicAppendFile({ root, path, content: "", maxBytes: 16 })
  expect(readPrivateFile({ root, path })?.toString()).toBe("terceira\nquarta\n")
  expect(() => atomicAppendFile({ root, path, content: "bad", maxBytes: 0 })).toThrow()
})

test("kernel and database initialization refuse linked directories and SQLite companions", () => {
  const { root, outside } = fixture()
  symlinkSync(outside, join(root, "logs"))
  expect(() => createKernel({ appData: root })).toThrow()
  const path = join(root, "touri.db")
  symlinkSync(join(outside, "wal"), `${path}-wal`)
  expect(() => prepareDatabaseFile({ root, path })).toThrow()
  expect(readdirSync(outside)).toEqual([])
})

test("secret persistence rejects linked keys and envelopes", async () => {
  const { root, outside } = fixture()
  symlinkSync(join(outside, "key"), join(root, "secrets.key"))
  expect(() => createSecretStore({ dir: root, env: {} })).toThrow()
  rmSync(join(root, "secrets.key"))
  const store = createSecretStore({ dir: root, env: {} })
  await store.set({ account: "test", value: "secret" })
  expect(store.get("test")).toBe("secret")
  rmSync(join(root, "secrets.enc"))
  symlinkSync(join(outside, "envelope"), join(root, "secrets.enc"))
  await expect(store.set({ account: "test", value: "other" })).rejects.toThrow()
  expect(readdirSync(outside)).toEqual([])
})

test("database opens and existing secrets retain private permissions without following links", () => {
  const { root, outside } = fixture()
  const key = join(root, "secrets.key")
  writeFileSync(key, `${"ab".repeat(32)}\n`, { mode: 0o644 })
  createSecretStore({ dir: root, env: {} })
  expect(statSync(key).mode & 0o777).toBe(0o600)
  const path = join(root, "touri.db")
  writeFileSync(path, "", { mode: 0o644 })
  const database = openDatabase({ filename: path })
  database.close()
  expect(statSync(path).mode & 0o777).toBe(0o600)
  rmSync(path)
  const external = join(outside, "data.db")
  writeFileSync(external, "untouched", { mode: 0o644 })
  symlinkSync(external, path)
  expect(() => openDatabase({ filename: path })).toThrow()
  expect(readFileSync(external, "utf8")).toBe("untouched")
  expect(statSync(external).mode & 0o777).toBe(0o644)
})

test("database paths permit an OS alias outside the application root", () => {
  const { root, parent } = fixture()
  const alias = join(parent, "parent-alias")
  symlinkSync(parent, alias)
  const filename = join(alias, "data", "touri.db")
  const database = openDatabase({ filename })
  try {
    expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(existsSync(join(root, "touri.db"))).toBe(true)
  } finally {
    database.close()
  }
})
