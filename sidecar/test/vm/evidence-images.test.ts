import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, VmRuntime } from "@touri/contracts"
import { folderGuestPath } from "../../src/kernel/bot-folders"
import {
  evidenceImageRoute,
  guestImage,
  imageMime,
  imagePath,
  localImage,
  MAX_IMAGE_BYTES,
} from "../../src/vm/evidence-images"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const root = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "touri-evidence-")))
  roots.push(path)
  return path
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
test("confines relative and absolute paths including encoded traversal, siblings and base directories", () => {
  expect(imagePath("/workspace", "/workspace/shots/a.png")).toBe("shots/a.png")
  expect(imagePath("/workspace", "./a.png", "reports")).toBe("reports/a.png")
  for (const path of ["../a.png", "shots/../a.png", "/etc/a.png", "/workspace-other/a.png", "a\\b.png", "bad\0.png"])
    expect(() => imagePath("/workspace", path)).toThrow()
  expect(() => imagePath("/workspace", "a.png", "../reports")).toThrow()
})
test("sniffs permitted raster signatures and refuses disguised HTML, SVG and truncated headers", () => {
  expect(imageMime(png)).toBe("image/png")
  expect(imageMime(Buffer.from([255, 216, 255, 0]))).toBe("image/jpeg")
  expect(imageMime(Buffer.from("GIF89a"))).toBe("image/gif")
  expect(imageMime(Buffer.from("RIFF0000WEBP"))).toBe("image/webp")
  for (const data of ["<html>fake.png", "<svg/>", "PNG", "RIFF"]) expect(imageMime(Buffer.from(data))).toBeNull()
})
test("streams from a pinned file and blocks leaf/ancestor links, nonfiles, MIME spoofing and oversized reads", async () => {
  const path = root()
  const outside = root()
  writeFileSync(join(path, "a.png"), png)
  writeFileSync(join(outside, "secret.png"), png)
  symlinkSync(join(outside, "secret.png"), join(path, "leaf.png"))
  symlinkSync(outside, join(path, "escape"))
  mkdirSync(join(path, "folder"))
  writeFileSync(join(path, "fake.png"), "<html>no</html>")
  writeFileSync(join(path, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1))
  for (const name of ["leaf.png", "escape/secret.png", "folder", "fake.png", "big.png"])
    expect(() => localImage(path, name)).toThrow()
  const result = localImage(path, "a.png")
  rmSync(join(path, "a.png"))
  symlinkSync(join(outside, "secret.png"), join(path, "a.png"))
  expect(Buffer.from(await new Response(result.stream).arrayBuffer())).toEqual(png)
  const cancel = localImage(outside, "secret.png")
  await cancel.stream.cancel()
})
const fixture = (running = false) => {
  const path = root()
  const attachments = join(path, "attachments")
  mkdirSync(attachments)
  const db = new Database(":memory:")
  db.exec(
    "CREATE TABLE attachments(id TEXT, path TEXT, origin_path TEXT); CREATE TABLE projects(id TEXT, path TEXT, archived_at INTEGER); CREATE TABLE threads(id TEXT,bot_id TEXT); CREATE TABLE messages(thread_id TEXT,parts_json TEXT)",
  )
  const bot = { id: "bot", machine: "vm", homeDir: path, projectId: null, cwd: null, archivedAt: null } as Bot
  let acquired = 0
  let released = 0
  const calls: unknown[] = []
  const kernel = {
    db,
    paths: { attachmentsDir: attachments, appData: join(path, "state") },
    services: { use: () => ({ getBot: () => bot }) },
  } as unknown as Kernel
  const vm = {
    states: () => [{ botId: "bot", status: running ? "running" : "stopped" }],
    acquire: async (input: unknown) => {
      acquired++
      calls.push(input)
      return async () => {
        released++
      }
    },
    exec: async (input: unknown) => {
      calls.push(input)
      return { success: true, stdout: JSON.stringify({ size: png.length, data: png.toString("base64") }) }
    },
  } as unknown as VmRuntime
  const route = evidenceImageRoute(kernel, vm)
  return {
    db,
    vm,
    path,
    attachments,
    bot,
    calls,
    counts: () => ({ acquired, released }),
    request: (query: Record<string, string>) =>
      route.handler({ params: { id: "bot" }, query, body: {}, signal: new AbortController().signal }),
  }
}
test("local images resolve against cwd and read-only grants with distinct missing and denied responses", async () => {
  const f = fixture()
  const cwd = root()
  const granted = root()
  const outside = root()
  Object.assign(f.bot, { machine: "local", cwd, folders: [{ path: granted, access: "read-only" }] })
  mkdirSync(join(granted, "reports"))
  writeFileSync(join(cwd, "post-01.png"), png)
  writeFileSync(join(granted, "reports/post-02.png"), png)
  symlinkSync(outside, join(granted, "escape"))
  try {
    for (const query of [
      { path: "post-01.png" },
      { path: join(granted, "reports/post-02.png") },
      { path: "post-02.png", base: join(granted, "reports") },
    ]) {
      const result = await f.request(query)
      expect(result.status).toBe(200)
      expect("stream" in result && Buffer.from(await new Response(result.stream).arrayBuffer())).toEqual(png)
    }
    for (const path of ["missing.png", join(granted, "missing/image.png")])
      expect((await f.request({ path })).status).toBe(404)
    for (const path of [join(outside, "missing.png"), `${granted}-other/post.png`, join(granted, "escape/a.png")])
      expect((await f.request({ path })).status).toBe(403)
    expect((await f.request({ path: "../post-01.png" })).status).toBe(400)
    expect((await f.request({ path: "%2e%2e/post-01.png" })).status).toBe(400)
  } finally {
    f.db.close()
  }
})
test("stopped VM returns a typed unavailable state without any acquire/exec", async () => {
  const f = fixture()
  try {
    const result = await f.request({ path: "/workspace/a.png" })
    expect(result.status).toBe(409)
    expect("json" in result && result.json).toMatchObject({ errorCode: "IMAGE_MACHINE_STOPPED" })
    expect(f.calls).toHaveLength(0)
  } finally {
    f.db.close()
  }
})
test("project fallback, cwd precedence, internal files and revoked grants share the image authorization boundary", async () => {
  const f = fixture()
  const project = root()
  const cwd = root()
  const granted = root()
  f.db.query("INSERT INTO projects VALUES (?,?,NULL)").run("project", project)
  Object.assign(f.bot, { machine: "local", projectId: "project", folders: [{ path: granted, access: "read-write" }] })
  for (const path of [f.path, project, cwd, granted]) writeFileSync(join(path, "post.png"), png)
  try {
    for (const path of ["post.png", join(f.path, "post.png"), join(granted, "post.png")]) {
      const result = await f.request({ path })
      expect(result.status).toBe(200)
      if ("stream" in result) await result.stream.cancel()
    }
    f.bot.cwd = cwd
    rmSync(join(project, "post.png"))
    const result = await f.request({ path: "post.png" })
    expect(result.status).toBe(200)
    if ("stream" in result) await result.stream.cancel()
    f.bot.folders = []
    expect((await f.request({ path: join(granted, "post.png") })).status).toBe(403)
    writeFileSync(join(cwd, "fake.png"), "<html>invalid</html>")
    expect((await f.request({ path: "fake.png" })).status).toBe(422)
  } finally {
    f.db.close()
  }
})
test("any-folder access preserves the application-data exclusion unless explicitly granted", async () => {
  const f = fixture()
  const granted = root()
  Object.assign(f.bot, { machine: "local", anyFolderAccess: true })
  mkdirSync(join(f.path, "state"))
  writeFileSync(join(f.path, "state/private.png"), png)
  writeFileSync(join(granted, "post.png"), png)
  try {
    const result = await f.request({ path: join(granted, "post.png") })
    expect(result.status).toBe(200)
    if ("stream" in result) await result.stream.cancel()
    expect((await f.request({ path: join(f.path, "state/private.png") })).status).toBe(403)
    symlinkSync(f.path, join(granted, "alias"))
    f.bot.cwd = join(granted, "alias/state")
    expect((await f.request({ path: "private.png" })).status).toBe(403)
    f.bot.cwd = null
    f.bot.folders = [{ path: join(f.path, "state"), access: "read-only" }]
    const allowed = await f.request({ path: join(f.path, "state/private.png") })
    expect(allowed.status).toBe(200)
    if ("stream" in allowed) await allowed.stream.cancel()
  } finally {
    f.db.close()
  }
})
test("VM image paths use granted mounts and preserve missing versus denied guest errors", async () => {
  const f = fixture(true)
  f.bot.folders = [{ path: "/output/marketing", access: "read-only" }]
  const mount = folderGuestPath("/output/marketing")
  try {
    for (const path of ["/output/marketing/post.png", `${mount}/post.png`]) {
      const result = await f.request({ path })
      expect(result.status).toBe(200)
      if ("stream" in result) await result.stream.cancel()
      expect(f.calls.at(-1)).toMatchObject({ args: ["-c", guestImage, "post.png", "0", mount] })
    }
    for (const status of [404, 403]) {
      f.vm.exec = async () => ({ success: true, stdout: JSON.stringify({ errorStatus: status }), stderr: "", code: 1 })
      expect((await f.request({ path: "post.png" })).status).toBe(status)
    }
    expect(f.counts().acquired).toBe(f.counts().released)
  } finally {
    f.db.close()
  }
})
test("running VM uses runningOnly and releases its lease after streaming/cancel", async () => {
  const f = fixture(true)
  try {
    const result = await f.request({ path: "/workspace/a.png" })
    expect(result.status).toBe(200)
    expect(f.calls[0]).toMatchObject({ runningOnly: true })
    expect("stream" in result && Buffer.from(await new Response(result.stream).arrayBuffer())).toEqual(png)
    expect(f.counts()).toEqual({ acquired: 1, released: 1 })
    const cancelled = await f.request({ path: "a.png" })
    if ("stream" in cancelled) await cancelled.stream.cancel()
    expect(f.counts().released).toBe(2)
  } finally {
    f.db.close()
  }
})
test("attachments read without VM wake and stored paths cannot escape the attachment root", async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.attachments, "a.png"), png)
    writeFileSync(join(f.path, "secret.png"), png)
    f.db.query("INSERT INTO attachments VALUES (?,?,?)").run("good", join(f.attachments, "a.png"), "/upload/a.png")
    f.db.query("INSERT INTO attachments VALUES (?,?,?)").run("bad", join(f.path, "secret.png"), null)
    f.db.exec(
      `INSERT INTO threads VALUES ('thread','bot'); INSERT INTO messages VALUES ('thread','[{"type":"image","attachmentId":"good"},{"type":"image","attachmentId":"bad"}]')`,
    )
    const result = await f.request({ path: "/upload/a.png" })
    expect(result.status).toBe(200)
    if ("stream" in result) await result.stream.cancel()
    expect((await f.request({ attachmentId: "bad" })).status).toBe(422)
    expect(f.calls).toHaveLength(0)
  } finally {
    f.db.close()
  }
})

test("A07: attachment ID and origin-path lookup require a message belonging to the selected bot", async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.attachments, "private.png"), png)
    f.db
      .query("INSERT INTO attachments VALUES (?,?,?)")
      .run("private", join(f.attachments, "private.png"), "/private.png")
    f.db.exec(
      `INSERT INTO threads VALUES ('victim','other-bot'); INSERT INTO messages VALUES ('victim','[{"type":"image","attachmentId":"private"}]')`,
    )
    for (const query of [{ attachmentId: "private" }, { path: "/private.png" }]) {
      const response = await f.request(query)
      if ("stream" in response) await response.stream.cancel()
      expect(response.status).toBe(404)
    }
  } finally {
    f.db.close()
  }
})

test("A07: shared source filenames still resolve the selected bot's own image", async () => {
  const f = fixture()
  try {
    writeFileSync(join(f.attachments, "foreign.png"), png)
    writeFileSync(join(f.attachments, "own.png"), png)
    f.db.query("INSERT INTO attachments VALUES (?,?,?)").run("foreign", join(f.attachments, "foreign.png"), "/same.png")
    f.db.query("INSERT INTO attachments VALUES (?,?,?)").run("own", join(f.attachments, "own.png"), "/same.png")
    f.db.exec(`INSERT INTO threads VALUES ('other','other-bot'),('own','bot');
      INSERT INTO messages VALUES ('other','[{"type":"image","attachmentId":"foreign"}]'),('own','[{"type":"image","attachmentId":"own"}]')`)
    const response = await f.request({ path: "/same.png" })
    expect(response.status).toBe(200)
    if ("stream" in response) await response.stream.cancel()
  } finally {
    f.db.close()
  }
})
test("guest reader enforces symlink and traversal confinement and the size cap", () => {
  const path = root()
  const outside = root()
  writeFileSync(join(path, "a.png"), png)
  writeFileSync(join(outside, "a.png"), png)
  symlinkSync(outside, join(path, "escape"))
  symlinkSync(join(outside, "a.png"), join(path, "link.png"))
  writeFileSync(join(path, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1))
  const script = guestImage.replace("'/workspace'", JSON.stringify(path))
  for (const name of ["../a.png", "escape/a.png", "link.png", "big.png"])
    expect(Bun.spawnSync(["python3", "-c", script, name, "0"]).exitCode).not.toBe(0)
  const good = Bun.spawnSync(["python3", "-c", script, "a.png", "0"])
  expect(good.exitCode).toBe(0)
  expect(JSON.parse(good.stdout.toString()).data).toBe(png.toString("base64"))
})

test("VM images larger than the exec limit stream in bounded blocks and release on failure", async () => {
  const f = fixture(true)
  const bytes = Buffer.alloc(2 * 1024 * 1024)
  png.copy(bytes)
  const offsets: number[] = []
  f.vm.exec = async (input) => {
    const offset = Number(input.args?.[3])
    offsets.push(offset)
    return {
      success: true,
      stdout: JSON.stringify({ size: bytes.length, data: bytes.subarray(offset, offset + 393216).toString("base64") }),
      stderr: "",
      code: 0,
    }
  }
  try {
    const result = await f.request({ path: "large.png" })
    expect("stream" in result && Buffer.from(await new Response(result.stream).arrayBuffer())).toEqual(bytes)
    expect(offsets).toEqual([0, 393216, 786432, 1179648, 1572864, 1966080])
    expect(f.counts().released).toBe(1)
    f.vm.exec = async () => ({ success: false, error: "No image", errorCode: "VM_ERROR" })
    expect((await f.request({ path: "large.png" })).status).toBe(422)
    expect(f.counts().released).toBe(2)
  } finally {
    f.db.close()
  }
})
