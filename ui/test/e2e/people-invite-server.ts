import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"

const root = resolve(import.meta.dirname, "../../..")
const uiDirectory = join(root, "ui/dist")
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

const getPort = (server: Server): number => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test server has no loopback port")

  return address.port
}

const listen = (server: Server) =>
  new Promise<void>((done, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      done()
    })
  })

const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

const waitForServer = async (serverUrl: string, child: ChildProcess, token?: string): Promise<boolean> => {
  const path = token ? "/api/v1/bots" : "/pair"
  const headers = token ? { Authorization: `Bearer ${token}`, "X-Touri-Client": "desktop-test" } : undefined
  for (const _attempt of Array.from({ length: 300 })) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("The isolated server exited")
    const ready = await fetch(`${serverUrl}${path}`, { headers, signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return true

    await wait(100)
  }

  return false
}

const getPairingCode = (dataDirectory: string): string => {
  const result = spawnSync("bun", ["run", "touri", "pair", "--data-dir", dataDirectory], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
  })
  const match = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(result.stdout ?? "")
  if (result.status !== 0 || !match?.[1]) throw new Error("The isolated pairing CLI did not create a code")

  return match[1]
}

export const createPeopleInviteServer = async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "touri-invite-e2e-"))
  const dataDirectory = join(fixtureDirectory, "data")
  await mkdir(dataDirectory)
  const provider = join(fixtureDirectory, "fixture-provider")
  const scenario = join(fixtureDirectory, "scenario.json")
  await writeFile(
    provider,
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(root, "sidecar/test/fakes/fake-codex.ts"))})\n`,
  )
  await chmod(provider, 0o700)
  await writeFile(scenario, JSON.stringify({ deltas: ["Olá, Ana! Posso ajudar o time."] }))
  const reservation = createServer()
  await listen(reservation)
  const serverPort = getPort(reservation)
  await close(reservation)
  const serverUrl = `http://127.0.0.1:${serverPort}`
  const pairCode = getPairingCode(dataDirectory)
  const child: ChildProcess = spawn(
    "bun",
    [
      "run",
      "touri",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(serverPort),
      "--data-dir",
      dataDirectory,
      "--ui-dir",
      uiDirectory,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TOURI_APP_DATA: dataDirectory,
        TOURI_CODEX_BIN: provider,
        TOURI_FAKE_SCENARIO: scenario,
        TOURI_BROWSER_HEADLESS: "1",
        TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  child.stdout?.resume()
  child.stderr?.resume()

  try {
    const started = await waitForServer(serverUrl, child)
    if (!started) throw new Error("The isolated server did not become ready")

    const pairResponse = await fetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: serverUrl },
      body: JSON.stringify({ code: pairCode, name: "Desktop test", client: true }),
      redirect: "error",
    })
    const pairResult = (await pairResponse.json()) as { token?: string }
    if (!pairResponse.ok || !pairResult.token) throw new Error("The isolated server rejected the pairing code")
    if (!(await waitForServer(serverUrl, child, pairResult.token)))
      throw new Error("The isolated workspace did not become ready")

    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${serverUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${pairResult.token}`,
          "X-Touri-Client": "desktop-test",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Isolated server request failed (${method} ${path}: ${response.status})`)

      return response.json()
    }

    await api("/public-address", "PUT", { address: "https://team.example.test" })
    const install = async (page: Page) => {
      await page
        .context()
        .addCookies([
          { name: "touri_device", value: pairResult.token ?? "", url: serverUrl, httpOnly: true, sameSite: "Strict" },
        ])
      await page.addInitScript(() => localStorage.setItem("touri.appearance.v1", "light"))
    }

    return { serverUrl, api, install, dispose: async () => stop(child, fixtureDirectory) }
  } catch (error) {
    await stop(child, fixtureDirectory)
    throw error
  }
}

const stop = async (child: ChildProcess, dataDirectory: string) => {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((done) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      child.once("exit", () => {
        clearTimeout(timeout)
        done()
      })
      child.kill("SIGTERM")
    })
  }

  await rm(dataDirectory, { recursive: true, force: true })
}
