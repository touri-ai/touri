import { type ChildProcess, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"

const root = resolve(import.meta.dirname, "../../..")
const serverUrl = "http://127.0.0.1:18795"

export const createWorkGoldenServer = async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-work-golden-"))
  const data = join(directory, "data")
  const scenario = join(directory, "scenario.json")
  const provider = join(directory, "fixture-provider")
  await mkdir(data)
  await writeFile(
    provider,
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(join(root, "sidecar/test/fakes/fake-codex.ts"))})\n`,
  )
  await chmod(provider, 0o700)
  const setScenario = (value: unknown) => writeFile(scenario, JSON.stringify(value))
  await setScenario({ deltas: ["Plano conferido. Podemos continuar."] })
  const pairing = await getPairingCode(data)
  const start = () => {
    const child = spawn(
      "bun",
      [
        "sidecar/src/cli/main.ts",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "18795",
        "--data-dir",
        data,
        "--ui-dir",
        join(root, "ui/dist"),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          TOURI_APP_DATA: data,
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
    return child
  }
  let child = start()
  try {
    await waitForServer(child)
    const paired = await fetch(`${serverUrl}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: serverUrl },
      body: JSON.stringify({ code: pairing, name: "Canal de demonstração", client: true }),
      signal: AbortSignal.timeout(15_000),
    })
    const { token } = (await paired.json()) as { token?: string }
    if (!paired.ok || !token) throw new Error("Synthetic server pairing failed")
    const api = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${serverUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Touri-Client": "desktop-test",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Synthetic request failed: ${method} ${path} (${response.status})`)
      return response.json()
    }
    return {
      serverUrl,
      api,
      setScenario,
      install: async (page: Page) => {
        await page
          .context()
          .addCookies([{ name: "touri_device", value: token, url: serverUrl, httpOnly: true, sameSite: "Strict" }])
        await page.addInitScript(() => {
          localStorage.setItem("touri.appearance.v1", "light")
          localStorage.setItem("touri.locale", "pt-BR")
        })
      },
      restart: async () => {
        await stop(child)
        child = start()
        await waitForServer(child)
      },
      dispose: async () => {
        await stop(child)
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await stop(child)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

const getPairingCode = async (data: string): Promise<string> => {
  const child = spawn("bun", ["ui/test/e2e/work-golden-pair.ts", data], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  })
  const chunks: string[] = []
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)))
  child.stderr.resume()
  const code = await new Promise<number | null>((done, reject) => {
    child.once("exit", done)
    child.once("error", reject)
  })
  const match = /Pairing code: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(chunks.join(""))
  if (code !== 0 || !match?.[1]) throw new Error("Synthetic pairing code failed")
  return match[1]
}

const waitForServer = (child: ChildProcess) =>
  new Promise<void>((done, reject) => {
    // Pairing is reachable before module initialization; wait for the CLI's completed startup instead.
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      child.stdout?.off("data", onOutput)
      child.off("exit", onExit)
      child.off("error", finish)
      if (error) reject(error)
      else done()
    }
    const onOutput = (chunk: Buffer) => {
      if (chunk.toString().includes("listening on")) finish()
    }
    const onExit = () => finish(new Error("Synthetic server exited"))
    const timeout = setTimeout(() => finish(new Error("Synthetic server startup timed out")), 60_000)
    child.stdout?.on("data", onOutput)
    child.once("exit", onExit)
    child.once("error", finish)
  })

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((done) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      done()
    })
    child.kill("SIGTERM")
  })
}
