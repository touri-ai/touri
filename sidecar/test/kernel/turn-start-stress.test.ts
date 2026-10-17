import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WebSocketOptions } from "bun"

// #121: a synchronous child process (`Bun.spawnSync`) ticks Bun's event loop while it waits, so
// HTTP and WebSocket callbacks re-enter in the middle of the request that started a turn. On
// Bun 1.2 that corrupts uWS's per-socket state: clients see stray `400 Bad Request` replies and
// the sidecar dies with a segfault in `AsyncSocket::uncork`.

const repoRoot = join(import.meta.dir, "..", "..", "..")
const sourceRoot = join(repoRoot, "sidecar", "src")
const fakeCodex = join(repoRoot, "sidecar", "test", "fakes", "fake-codex.ts")
const token = "stress-token"
const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
const STRESS_MS = Number(process.env.TOURI_STRESS_MS ?? 8_000)

const sourceFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "image" ? [] : sourceFiles(path)
    return /\.(ts|js|cjs|mjs)$/.test(name) ? [path] : []
  })

test("the sidecar never runs a synchronous child process (it re-enters the HTTP server)", () => {
  const offenders = sourceFiles(sourceRoot).filter((path) =>
    /\b(spawnSync|execSync|execFileSync)\s*\(/.test(readFileSync(path, "utf8")),
  )
  expect(offenders.map((path) => path.slice(repoRoot.length + 1))).toEqual([])
})

const readHandshake = async (stream: ReadableStream<Uint8Array>): Promise<{ port: number }> => {
  const reader = stream.getReader()
  let output = ""
  while (!output.includes("touri-sidecar-ready")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`sidecar exited before its handshake: ${output}`)
    output += new TextDecoder().decode(chunk.value)
  }
  reader.releaseLock()
  const line = output.split("\n").find((item) => item.includes("touri-sidecar-ready")) ?? "{}"
  return JSON.parse(line) as { port: number }
}

test(
  "many turns starting while event clients are connected keep the sidecar alive",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-turn-stress-"))
    const assets = mkdtempSync(join(tmpdir(), "touri-turn-stress-cli-"))
    const codex = join(assets, "codex")
    writeFileSync(codex, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(fakeCodex)} "$@"\n`)
    chmodSync(codex, 0o700)
    const sidecar = Bun.spawn({
      cmd: [process.execPath, "run", join(sourceRoot, "main.ts"), "serve"],
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: assets,
        TOURI_APP_DATA: root,
        TOURI_UI_TOKEN: token,
        TOURI_HEADLESS: "1",
        TOURI_CODEX_BIN: codex,
        TOURI_PARENT_PID: String(process.pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    let exitCode: number | null = null
    void sidecar.exited.then((code) => {
      exitCode = code
    })
    const sockets: Array<WebSocket> = []
    try {
      const { port } = await readHandshake(sidecar.stdout)
      const base = `http://127.0.0.1:${port}/api/v1`
      const headers = {
        Authorization: `Bearer ${token}`,
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      }
      const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> }
      }
      const threads: Array<string> = []
      for (const name of ["ana", "bia", "caio", "duda"]) {
        const created = await api("POST", "/bots", { name, provider: "codex", instructions: "Seja útil." })
        const botId = (created.json?.bot as { id?: string } | undefined)?.id
        if (!botId) throw new Error(`bot creation failed: ${JSON.stringify(created)}`)
        const listed = await api("GET", `/bots/${botId}/threads`)
        threads.push((listed.json.threads as Array<{ id: string }>)[0]?.id ?? "")
      }
      const deadline = Date.now() + STRESS_MS
      const alive = (): boolean => exitCode === null && Date.now() < deadline
      const statuses = new Map<number, number>()
      let turns = 0
      let events = 0
      const listen = async (): Promise<void> => {
        while (alive()) {
          const ticket = await api("POST", "/ws-ticket", { path: "/api/v1/events" })
          const socket = new NativeSocket(`ws://127.0.0.1:${port}/api/v1/events?since=1&ticket=${ticket.json.ticket}`, {
            headers: { Origin: "tauri://localhost" },
          })
          socket.onmessage = () => {
            events++
          }
          sockets.push(socket)
          await Bun.sleep(300 + Math.random() * 900)
          socket.close()
        }
      }
      const startTurns = async (): Promise<void> => {
        while (alive()) {
          const threadId = threads[Math.floor(Math.random() * threads.length)] ?? ""
          const status = await fetch(`${base}/threads/${threadId}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ text: `oi ${turns}` }),
          }).then(
            async (response) => {
              await response.arrayBuffer()
              return response.status
            },
            () => -1,
          )
          turns++
          statuses.set(status, (statuses.get(status) ?? 0) + 1)
          await Bun.sleep(Math.random() * 150)
        }
      }
      await Promise.all([listen(), listen(), startTurns(), startTurns(), startTurns(), startTurns()])
      await Bun.sleep(200)
      const stderr = exitCode === null ? "" : await new Response(sidecar.stderr).text()
      expect({ exitCode, crash: stderr.match(/panic.*|Segmentation fault.*/)?.[0] ?? null }).toEqual({
        exitCode: null,
        crash: null,
      })
      expect(turns).toBeGreaterThan(20)
      expect(events).toBeGreaterThan(0)
      // Every request is well-formed; only queueing (201) or a busy bot (503) are valid answers.
      expect([...statuses.keys()].filter((status) => status !== 201 && status !== 503)).toEqual([])
    } finally {
      for (const socket of sockets) socket.close()
      // A graceful stop also ends the provider processes the turns started.
      sidecar.kill("SIGTERM")
      if ((await Promise.race([sidecar.exited, Bun.sleep(8_000).then(() => "timeout")])) === "timeout")
        sidecar.kill("SIGKILL")
      await sidecar.exited
      rmSync(root, { recursive: true, force: true })
      rmSync(assets, { recursive: true, force: true })
    }
  },
  STRESS_MS + 30_000,
)
