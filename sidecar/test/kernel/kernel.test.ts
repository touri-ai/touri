import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WebSocketOptions } from "bun"
import { createKernel, isAllowedOrigin } from "../../src/kernel"
import { openDatabase } from "../../src/kernel/db"
import baseSql from "../../src/kernel/migrations/0001.sql" with { type: "text" }
import notificationsSql from "../../src/kernel/migrations/0002.sql" with { type: "text" }
import avatarsSql from "../../src/kernel/migrations/0003.sql" with { type: "text" }
import machinesSql from "../../src/kernel/migrations/0004.sql" with { type: "text" }
import { compactTranscript } from "../../src/kernel/transcript-storage"
import { createFakeHost } from "../fakes/fakeHost"
import { socketTicket } from "../fakes/ws-ticket"

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "touri-wp0-"))

const websocketStatus = async ({ port, origin }: { port: number; origin?: string }): Promise<string> => {
  const ticket = await socketTicket(port, "/api/v1/events", "ws-token")
  const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const candidate = createConnection(port, "127.0.0.1")
    candidate.once("connect", () => resolve(candidate))
    candidate.once("error", reject)
  })
  const originHeader = origin === undefined ? "" : `Origin: ${origin}\r\n`
  const response = await new Promise<string>((resolve, reject) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      const end = buffer.indexOf("\r\n\r\n")
      if (end >= 0) resolve(buffer.slice(0, end))
    })
    socket.once("error", reject)
    socket.write(
      `GET /api/v1/events?ticket=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${originHeader}\r\n`,
    )
  })
  socket.destroy()
  return response
}

test("Origin allowlist accepts both bundled Tauri origins and the Vite dev origin", () => {
  expect(isAllowedOrigin("tauri://localhost")).toBe(true)
  expect(isAllowedOrigin("http://tauri.localhost")).toBe(true)
  expect(isAllowedOrigin("http://localhost:1420")).toBe(true)
  expect(isAllowedOrigin("https://evil.example")).toBe(false)
  expect(isAllowedOrigin(null)).toBe(false)
})

test("migration applies with foreign keys clean and exposes the handshake", () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  try {
    const database = runtime.kernel.db as Database
    expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({ value: "15" })
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect(runtime.handshake.type).toBe("touri-sidecar-ready")
    expect(runtime.handshake.port).toBeGreaterThan(0)
    expect(runtime.handshake.schemaVersion).toBe(15)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("opening an existing database applies migrations idempotently", () => {
  const root = tempRoot()
  const first = createKernel({ appData: root })
  first.stop()
  const second = createKernel({ appData: root })
  try {
    expect(
      (second.kernel.db as Database).query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get(),
    ).toEqual({
      value: "15",
    })
  } finally {
    second.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["avatars", "vm", "r2-role"])(
  "upgrading an existing %s database appends VM and role settings and preserves data across reopens",
  (schema) => {
    const root = tempRoot()
    const filename = join(root, "touri.db")
    let database = new Database(filename, { create: true })
    try {
      database.exec(baseSql)
      database.exec(notificationsSql)
      database.exec(avatarsSql)
      if (schema === "vm") database.exec(machinesSql)
      if (schema === "r2-role")
        database.exec(
          "ALTER TABLE bots ADD COLUMN role_line TEXT; INSERT INTO schema_meta (key, value) VALUES ('bot_role_version', '1');",
        )
      database
        .query(
          "INSERT INTO bots (id, name, provider, home_dir, avatar_shape, avatar_seed, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("existing", "Avatar bot", "codex", join(root, "bots", "existing"), "nuage", "chosen", "#2468ac", 1, 1)
      if (schema === "vm") {
        database.exec("UPDATE bots SET machine = 'vm', machine_idle_minutes = 30")
        database
          .query("INSERT INTO bot_machines (bot_id, vm_id, volume) VALUES (?, ?, ?)")
          .run("existing", "vm-existing", "existing-volume")
      }
      if (schema === "r2-role") database.exec("UPDATE bots SET role_line = 'SEO do site'")
      database.close()
      database = openDatabase({ filename })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
        value: "15",
      })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'avatar_identity_version'").get()).toEqual({
        value: "1",
      })
      expect(
        database.query("SELECT avatar_shape, avatar_seed, color, machine, machine_idle_minutes FROM bots").get(),
      ).toEqual({
        avatar_shape: "nuage",
        avatar_seed: "chosen",
        color: "#2468ac",
        machine: schema === "vm" ? "vm" : "local",
        machine_idle_minutes: schema === "vm" ? 30 : 15,
      })
      expect(database.query("SELECT role_line FROM bots").get()).toEqual({
        role_line: schema === "r2-role" ? "SEO do site" : null,
      })
      database.exec("UPDATE bots SET role_line = 'Touri · Coder'")
      database.exec(
        "UPDATE bots SET machine = 'vm', machine_idle_minutes = 30, vm_provider_login = 1, host_computer_use = 1",
      )
      database
        .query("INSERT OR IGNORE INTO bot_machines (bot_id, vm_id, volume) VALUES (?, ?, ?)")
        .run("existing", "vm-existing", "existing-volume")
      database.close()
      database = openDatabase({ filename })
      expect(
        database
          .query(
            "SELECT avatar_shape, avatar_seed, machine, machine_idle_minutes, vm_provider_login, host_computer_use FROM bots",
          )
          .get(),
      ).toEqual({
        avatar_shape: "nuage",
        avatar_seed: "chosen",
        machine: "vm",
        machine_idle_minutes: 30,
        vm_provider_login: 1,
        host_computer_use: 1,
      })
      expect(database.query("SELECT vm_id, volume FROM bot_machines WHERE bot_id = 'existing'").get()).toEqual({
        vm_id: "vm-existing",
        volume: "existing-volume",
      })
      expect(database.query("SELECT role_line FROM bots").get()).toEqual({ role_line: "Touri · Coder" })
      expect(database.query("SELECT value FROM schema_meta WHERE key = 'bot_role_version'").get()).toEqual({
        value: "1",
      })
      expect(database.query("PRAGMA table_info(processes)").all()).toContainEqual(
        expect.objectContaining({ name: "vm_bot_id" }),
      )
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("HTTP auth rejects bad token, Origin, and Host with 401, 403, and 421", async () => {
  const root = tempRoot()
  const previousToken = process.env.TOURI_UI_TOKEN
  process.env.TOURI_UI_TOKEN = "test-ui-token"
  const runtime = createKernel({ appData: root })
  const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/health`
  const headers = { Authorization: "Bearer test-ui-token", Origin: "tauri://localhost" }
  try {
    expect((await fetch(url, { headers: { ...headers, Authorization: "Bearer wrong" } })).status).toBe(401)
    expect((await fetch(`${url}?token=test-ui-token`, { headers: { Origin: "tauri://localhost" } })).status).toBe(401)
    expect((await fetch(url, { headers: { Authorization: "Bearer test-ui-token" } })).status).toBe(403)
    expect((await fetch(url, { headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403)
    expect((await fetch(url, { headers: { ...headers, Host: "evil.example" } })).status).toBe(421)
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Method": "GET",
        Origin: "tauri://localhost",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost")
    const healthy = await fetch(url, { headers })
    expect(healthy.status).toBe(200)
    expect(healthy.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost")
    expect(await healthy.json()).toMatchObject({ ok: true, schemaVersion: 15 })
  } finally {
    runtime.stop()
    if (previousToken === undefined) delete process.env.TOURI_UI_TOKEN
    else process.env.TOURI_UI_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test("WebSocket auth rejects a missing Origin but accepts the exact app Origin", async () => {
  const root = tempRoot()
  const previousToken = process.env.TOURI_UI_TOKEN
  process.env.TOURI_UI_TOKEN = "ws-token"
  const runtime = createKernel({ appData: root })
  try {
    expect((await websocketStatus({ port: runtime.handshake.port })).startsWith("HTTP/1.1 403")).toBe(true)
    expect(
      (await websocketStatus({ port: runtime.handshake.port, origin: "tauri://localhost" })).startsWith("HTTP/1.1 101"),
    ).toBe(true)
    expect(
      (await websocketStatus({ port: runtime.handshake.port, origin: "http://tauri.localhost" })).startsWith(
        "HTTP/1.1 101",
      ),
    ).toBe(true)
  } finally {
    runtime.stop()
    if (previousToken === undefined) delete process.env.TOURI_UI_TOKEN
    else process.env.TOURI_UI_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test("published websocket events preserve increasing sequence numbers", async () => {
  const root = tempRoot()
  const previousToken = process.env.TOURI_UI_TOKEN
  process.env.TOURI_UI_TOKEN = "ws-token"
  const runtime = createKernel({ appData: root })
  const received: Array<number> = []
  const ticket = await socketTicket(runtime.handshake.port, "/api/v1/events", "ws-token")
  const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const candidate = createConnection(runtime.handshake.port, "127.0.0.1")
    candidate.once("connect", () => {
      candidate.on("data", (chunk) => {
        const text = chunk.toString("utf8")
        for (const match of text.matchAll(/"seq":(\d+)/g)) received.push(Number(match[1]))
      })
      candidate.write(
        `GET /api/v1/events?ticket=${ticket} HTTP/1.1\r\nHost: 127.0.0.1:${runtime.handshake.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: tauri://localhost\r\n\r\n`,
      )
      resolve(candidate)
    })
    candidate.once("error", reject)
  })
  try {
    await Bun.sleep(20)
    runtime.kernel.publish({ type: "notify", level: "info", title: "one", body: "one", threadId: null })
    runtime.kernel.publish({ type: "notify", level: "info", title: "two", body: "two", threadId: null })
    const deadline = Date.now() + 1000
    while (received.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(received.slice(-2)).toEqual([1, 2])
  } finally {
    socket.destroy()
    runtime.stop()
    if (previousToken === undefined) delete process.env.TOURI_UI_TOKEN
    else process.env.TOURI_UI_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["-1", "1.5", "invalid", "9007199254740992"])(
  "event websocket rejects invalid cursor %s before upgrading",
  async (since) => {
    const root = tempRoot()
    const runtime = createKernel({ appData: root })
    try {
      const ticket = await socketTicket(runtime.handshake.port, "/api/v1/events")
      const response = await fetch(
        `http://127.0.0.1:${runtime.handshake.port}/api/v1/events?ticket=${ticket}&since=${since}`,
        {
          headers: {
            Authorization: "Bearer dev-ui-token",
            Origin: "tauri://localhost",
            Upgrade: "websocket",
          },
        },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ errorCode: "INVALID_CURSOR" })
    } finally {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("event websocket replays from since, continues live delivery and resyncs expired cursors", async () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  const sockets: Array<WebSocket> = []
  const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
  const publish = () =>
    runtime.kernel.publish({ type: "import.progress", importId: "replay", phase: "done", done: 1, total: 1 })
  const receive = async (since: number, count: number, live = false) => {
    const ticket = await socketTicket(runtime.handshake.port, "/api/v1/events")
    return new Promise<Array<unknown>>((resolve, reject) => {
      const socket = new NativeSocket(
        `ws://127.0.0.1:${runtime.handshake.port}/api/v1/events?ticket=${ticket}&since=${since}`,
        { headers: { Origin: "tauri://localhost" } },
      )
      sockets.push(socket)
      const frames: Array<unknown> = []
      socket.onopen = () => {
        if (live) publish()
      }
      socket.onerror = () => reject(new Error("Event websocket failed"))
      socket.onmessage = (message) => {
        frames.push(JSON.parse(String(message.data)))
        if (frames.length === count) {
          socket.close()
          resolve(frames)
        }
      }
    })
  }
  try {
    publish()
    publish()
    expect(await receive(1, 2, true)).toMatchObject([
      { seq: 2, event: { type: "import.progress" } },
      { seq: 3, event: { type: "import.progress" } },
    ])
    compactTranscript({ database: runtime.kernel.db as Database, events: 1 })
    expect(await receive(0, 1)).toEqual([{ type: "resync", lastSeq: 3 }])
    expect(await receive(4, 1)).toEqual([{ type: "resync", lastSeq: 3 }])
  } finally {
    for (const socket of sockets) socket.close()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("kernel shutdown disposes the desktop service and removes its private handshake", () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  let disposed = 0
  runtime.kernel.services.provide("vm.desktop", {
    claim: () => false,
    open: () => undefined,
    message: () => undefined,
    close: () => undefined,
    revokeControl: () => undefined,
    closeBot: async () => undefined,
    dispose: () => {
      disposed += 1
    },
  })
  try {
    expect(existsSync(join(runtime.kernel.paths.runDir, "handshake.json"))).toBe(true)
    runtime.stop()
    expect(disposed).toBe(1)
    expect(existsSync(join(runtime.kernel.paths.runDir, "handshake.json"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("redaction masks registered multiline secrets and tools are stored by the registry", () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  try {
    runtime.kernel.addRedactionValue("line-two-secret")
    expect(runtime.kernel.redact("line-one\nline-two-secret\nline-three")).toBe("line-one\n[REDACTED]\nline-three")
    const registration = runtime.kernel.registerTools({
      tools: [{ name: "history_search", group: "core", handler: async () => ({ success: true, content: [] }) }],
    })
    expect(registration).toEqual({ success: true, count: 1 })
    const duplicate = runtime.kernel.registerTools({
      tools: [{ name: "history_search", group: "core", handler: async () => ({ success: true, content: [] }) }],
    })
    const unknown = runtime.kernel.registerTools({
      tools: [{ name: "not-a-tool", group: "core", handler: async () => ({ success: true, content: [] }) }],
    })
    expect(duplicate.success).toBe(false)
    expect(unknown.success).toBe(false)
    if (!duplicate.success) expect(duplicate.errorCode).toBe("DUPLICATE_TOOL")
    if (!unknown.success) expect(unknown.errorCode).toBe("UNKNOWN_TOOL")
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("shellEnv returns a login environment with available tool directories", async () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: root })
  try {
    const environment = await runtime.kernel.shellEnv()
    expect(environment.PATH?.split(":")).toContain("/usr/bin")
    if (existsSync("/opt/homebrew/bin")) expect(environment.PATH?.split(":")).toContain("/opt/homebrew/bin")
    expect(environment.SHELL).toBeString()
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("fake host implements keychain round trips without storing values in SQLite", async () => {
  const fake = createFakeHost()
  await fake.methods["keychain.set"]({ account: "global/API_KEY", value: "hunter2-secret" })
  expect(await fake.methods["keychain.get"]({ account: "global/API_KEY" })).toEqual({ value: "hunter2-secret" })
  await fake.methods["keychain.delete"]({ account: "global/API_KEY" })
  expect(await fake.methods["keychain.get"]({ account: "global/API_KEY" })).toEqual({ value: null })
})

test("fixture tree contains the importer edge cases and never requires decoy credentials", () => {
  const fixture = join(import.meta.dir, "..", "fixtures", "legacy")
  const counts = JSON.parse(readFileSync(join(fixture, "expected-counts.json"), "utf8")) as {
    bots: number
    threads: number
    messages: number
    messageKinds: Record<string, number>
  }
  const bots = JSON.parse(readFileSync(join(fixture, "bots.json"), "utf8")) as Array<{ id: string }>
  const database = new Database(join(fixture, "messages.db"), { readonly: true })
  try {
    expect(bots).toHaveLength(counts.bots)
    expect(database.query("SELECT count(*) AS count FROM thread_state").get()).toEqual({ count: counts.threads })
    expect(database.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: counts.messages })
    for (const [kind, count] of Object.entries(counts.messageKinds)) {
      expect(database.query("SELECT count(*) AS count FROM messages WHERE kind = ?").get(kind)).toEqual({ count })
    }
    expect(readFileSync(join(fixture, "config.json"), "utf8")).toContain("DO NOT READ")
    expect(readFileSync(join(fixture, "sessions.json"), "utf8")).toContain("DO NOT READ")
    expect(readFileSync(join(fixture, "hook-tokens", "active"), "utf8")).toContain("DO NOT READ")
  } finally {
    database.close()
  }
})
