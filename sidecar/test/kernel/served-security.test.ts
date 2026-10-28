import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { directoryAssets } from "../../src/cli/web/uiAssets"
import { createKernel } from "../../src/kernel"
import { init } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-served-security-"))
  const runtime = createKernel({ appData: root })
  await init(runtime.kernel)
  cleanups.add(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const call = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { root, runtime, call }
}

test("A02: active imported MIME is downloaded with sandbox, nosniff and no-store", async () => {
  const f = await fixture()
  const path = join(f.root, "attachments", "payload.html")
  writeFileSync(path, "<svg onload=alert(1) />")
  ;(f.runtime.kernel.db as Database)
    .query("INSERT INTO attachments (id,path,mime,bytes,created_at) VALUES (?,?,?,?,?)")
    .run("active", path, "image/png", 24, Date.now())
  const response = await f.call("/attachments/active")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-disposition")).toStartWith("attachment")
  expect(response.headers.get("content-type")).toBe("application/octet-stream")
  expect(response.headers.get("content-security-policy")).toContain("sandbox")
  expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("A07: an ungranted host path is refused; uploaded bytes remain downloadable", async () => {
  const f = await fixture()
  const path = join(f.root, "private.txt")
  writeFileSync(path, "synthetic-private-file")
  expect((await f.call("/attachments", { path })).status).toBe(403)
  const response = await f.call("/attachments", {
    name: "file.svg",
    dataBase64: Buffer.from("<svg/>").toString("base64"),
  })
  expect(response.status).toBe(201)
  const { attachment } = (await response.json()) as { attachment: { id: string; mime: string } }
  expect(attachment.mime).toBe("application/octet-stream")
  expect(await (await f.call(`/attachments/${attachment.id}`)).text()).toBe("<svg/>")
})

test("A07: UI directories reject leaf and ancestor symlinks", async () => {
  const f = await fixture()
  writeFileSync(join(f.root, "private.js"), "synthetic-private-file")
  symlinkSync(join(f.root, "private.js"), join(f.root, "attachments", "escape.js"))
  symlinkSync(f.root, join(f.root, "attachments", "linked"))
  const ui = directoryAssets(join(f.root, "attachments"))
  expect(ui.get("escape.js")).toBeNull()
  expect(ui.get("linked/private.js")).toBeNull()
})

test("S14: WebSocket reusable bearer query authentication is refused", async () => {
  const f = await fixture()
  const response = await fetch(`http://127.0.0.1:${f.runtime.handshake.port}/api/v1/events?token=dev-ui-token`, {
    headers: { Upgrade: "websocket", Origin: "tauri://localhost" },
  })
  expect(response.status).toBe(401)
})

test("S14: authenticated ticket minting exposes CORS to the app origin", async () => {
  const f = await fixture()
  const response = await f.call("/ws-ticket", { path: "/api/v1/events" })
  expect(response.status).toBe(201)
  expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost")
})

test("A07: attachment download rejects symlinks and oversized regular files", async () => {
  const f = await fixture()
  const path = join(f.root, "attachments", "linked.txt")
  writeFileSync(join(f.root, "private.txt"), "synthetic-private-file")
  symlinkSync(join(f.root, "private.txt"), path)
  ;(f.runtime.kernel.db as Database)
    .query("INSERT INTO attachments (id,path,mime,bytes,created_at) VALUES (?,?,?,?,?)")
    .run("linked", path, "text/plain", 1, Date.now())
  expect((await f.call("/attachments/linked")).status).toBeGreaterThanOrEqual(400)
  const big = join(f.root, "attachments", "big.bin")
  writeFileSync(big, "")
  truncateSync(big, 15 * 1024 * 1024 + 1)
  ;(f.runtime.kernel.db as Database)
    .query("INSERT INTO attachments (id,path,mime,bytes,created_at) VALUES (?,?,?,?,?)")
    .run("big", big, "application/octet-stream", 15 * 1024 * 1024 + 1, Date.now())
  expect((await f.call("/attachments/big")).status).toBeGreaterThanOrEqual(400)
})

test("A02: verified raster is inline while a spoofed upload MIME is ignored", async () => {
  const f = await fixture()
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
  const upload = await f.call("/attachments", {
    name: "image.html",
    mime: "text/html",
    dataBase64: png.toString("base64"),
  })
  const { attachment } = (await upload.json()) as { attachment: { id: string; mime: string } }
  expect(attachment.mime).toBe("image/png")
  const response = await f.call(`/attachments/${attachment.id}`)
  expect(response.headers.get("content-disposition")).toBe("inline")
  expect(response.headers.get("content-type")).toBe("image/png")
})

test("A02: imported attachment disposition follows bounded bytes, never stored MIME", async () => {
  const f = await fixture()
  const database = f.runtime.kernel.db as Database
  const fixtures = [
    {
      id: "imported-active",
      bytes: Buffer.from("<html><script>alert(1)</script></html>"),
      mime: "image/jpeg",
      expected: "application/octet-stream",
      disposition: "attachment",
    },
    {
      id: "imported-raster",
      bytes: Buffer.from([255, 216, 255, 224]),
      mime: "text/html",
      expected: "image/jpeg",
      disposition: "inline",
    },
  ]
  for (const attachment of fixtures) {
    const path = join(f.root, "attachments", attachment.id)
    await Bun.write(path, attachment.bytes)
    database
      .query("INSERT INTO attachments (id,path,mime,bytes,created_at) VALUES (?,?,?,?,?)")
      .run(attachment.id, path, attachment.mime, attachment.bytes.length, Date.now())

    const response = await f.call(`/attachments/${attachment.id}`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe(attachment.expected)
    expect(response.headers.get("content-disposition")).toBe(attachment.disposition)
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(Buffer.from(await response.arrayBuffer())).toEqual(attachment.bytes)
  }
})
