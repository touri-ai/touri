import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { errorRegistry } from "@touri/contracts/errors"
import { buildChildEnv } from "../kernel"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import { poll } from "../kernel/policy"
import { discardStream } from "../kernel/streams"
import { connectCdpWebSocket, createCdpClient } from "./cdp"
import type { CdpClient } from "./types"

type SpawnedChrome = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>

export type ChromeLauncher = {
  start: (input?: { runningOnly?: boolean }) => Promise<{ client: CdpClient; process?: SpawnedChrome } | null>
  stop: () => Promise<void>
}

export type ChromeWindowConfig = {
  width: number
  height: number
  left: number | null
  top: number | null
  headless: boolean
}

export { type ChromeDownloadDeps, downloadChromeForTesting } from "../platform/macos/chrome"

import { downloadChromeForTesting, systemChrome } from "../platform/macos/chrome"

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

const integerPair = (value: string | undefined, { positive }: { positive: boolean }): [number, number] | null => {
  if (!value) return null
  const parts = value.split(",")
  if (parts.length !== 2) return null
  const first = Number(parts[0])
  const second = Number(parts[1])
  if (!Number.isInteger(first) || !Number.isInteger(second)) return null
  if (positive && (first <= 0 || second <= 0)) return null
  return [first, second]
}

export const deriveChromeWindowConfig = ({
  env = process.env,
}: {
  env?: Record<string, string | undefined>
} = {}): ChromeWindowConfig => {
  const size = integerPair(env.TOURI_BROWSER_WINDOW_SIZE, { positive: true }) ?? [1280, 860]
  const position = integerPair(env.TOURI_BROWSER_WINDOW_POSITION, { positive: false })
  return {
    width: size[0],
    height: size[1],
    left: position?.[0] ?? null,
    top: position?.[1] ?? null,
    headless: env.TOURI_BROWSER_HEADLESS === "1",
  }
}

export const deriveChromeWindowArgs = ({
  env = process.env,
}: {
  env?: Record<string, string | undefined>
} = {}): Array<string> => {
  const config = deriveChromeWindowConfig({ env })
  return [
    `--window-size=${config.width},${config.height}`,
    ...(config.left === null || config.top === null ? [] : [`--window-position=${config.left},${config.top}`]),
  ]
}

export const deriveChromeLaunchArgs = ({
  profile,
  env = process.env,
}: {
  profile: string
  env?: Record<string, string | undefined>
}): Array<string> => {
  const config = deriveChromeWindowConfig({ env })
  return [
    `--user-data-dir=${profile}`,
    ...(config.headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    ...deriveChromeWindowArgs({ env }),
    "--restore-last-session=false",
    "--remote-debugging-pipe",
    "about:blank",
  ]
}

export const deriveChromePortLaunchArgs = ({
  profile,
  env = process.env,
}: {
  profile: string
  env?: Record<string, string | undefined>
}): Array<string> => {
  const pipeArgs = deriveChromeLaunchArgs({ profile, env })
  const pipeIndex = pipeArgs.indexOf("--remote-debugging-pipe")
  if (pipeIndex < 0) return pipeArgs
  return [
    ...pipeArgs.slice(0, pipeIndex),
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    ...pipeArgs.slice(pipeIndex + 1),
  ]
}

export const parseDevToolsActivePort = (value: string): { port: number; path: string } | null => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const port = Number(lines[0])
  const path = lines[1]
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path?.startsWith("/")) return null
  return { port, path }
}

export class LocalBrowserUnavailableError extends Error {
  readonly errorCode = "LOCAL_BROWSER_UNAVAILABLE"
  constructor() {
    super(errorRegistry["TOURI-E4006"].message)
    this.name = "LocalBrowserUnavailableError"
  }
}

/** Attaches to Chrome with the user's consent. This launcher owns only its CDP connection. */
export const attachLocalChrome = ({
  dataDir = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
    : join(homedir(), ".config", "google-chrome"),
  timeoutMs = 5000,
}: {
  dataDir?: string
  timeoutMs?: number
} = {}): ChromeLauncher => {
  let client: CdpClient | null = null
  let pending: Promise<{ client: CdpClient }> | null = null
  let lifetime = new AbortController()
  const start = async (): Promise<{ client: CdpClient }> => {
    if (client && !client.isClosed()) return { client }
    if (pending) return pending
    const controller = new AbortController()
    lifetime = controller
    pending = (async () => {
      let transport: CdpClient | null = null
      try {
        const lines = readFileSync(join(dataDir, "DevToolsActivePort"), "utf8").split(/\r?\n/)
        const port = lines[0]?.trim() ?? ""
        const path = lines[1]?.trim() ?? ""
        // Accept only the two Chrome fields, never a URL, authority, query or redirect.
        if (
          !/^\d+$/.test(port) ||
          Number(port) < 1 ||
          Number(port) > 65535 ||
          !/^\/devtools\/browser\/[\w-]+$/.test(path)
        )
          throw new LocalBrowserUnavailableError()
        transport = await connectCdpWebSocket({
          url: `ws://127.0.0.1:${Number(port)}${path}`,
          timeoutMs,
          signal: controller.signal,
        })
        await transport.call("Browser.getVersion")
        controller.signal.throwIfAborted()
        client = transport
        return { client }
      } catch {
        await transport?.close()
        throw new LocalBrowserUnavailableError()
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
  return {
    start,
    stop: async () => {
      lifetime.abort()
      const current = client
      client = null
      await current?.close()
    },
  }
}

const chromeExecutable = async ({
  kernel,
  mode,
}: {
  kernel: Kernel
  mode: "system-chrome" | "chrome-for-testing"
}): Promise<string | null> => {
  if (process.platform !== "darwin") {
    // Linux uses the distribution-maintained browser. Never download an Apple bundle.
    return (
      process.env.TOURI_CHROME_BIN ??
      Bun.which("chromium") ??
      Bun.which("chromium-browser") ??
      Bun.which("google-chrome")
    )
  }
  if (mode === "system-chrome" && existsSync(systemChrome)) return systemChrome
  const result = await downloadChromeForTesting({
    root: kernel.paths.appData,
    destination: join(kernel.paths.browserDir, "chrome"),
  })
  if (!result.success) {
    kernel.log({
      level: "warn",
      module: "browser",
      msg: "Chrome for Testing is unavailable",
      data: { error: result.error },
    })
    return null
  }
  return result.path
}

export const createChromeLauncher = ({
  kernel,
  mode = "system-chrome",
}: {
  kernel: Kernel
  mode?: "system-chrome" | "chrome-for-testing"
}): ChromeLauncher => {
  let active: { client: CdpClient; process: SpawnedChrome } | null = null

  const environment = async (): Promise<Record<string, string>> => {
    return buildChildEnv({ base: await kernel.shellEnv(), overrides: process.env })
  }

  const stopSpawned = async (process: SpawnedChrome): Promise<void> => {
    process.kill("SIGTERM")
    const exited = await Promise.race([process.exited.then(() => true), Bun.sleep(2000).then(() => false)])
    if (!exited) process.kill("SIGKILL")
    await Promise.race([process.exited, Bun.sleep(2000)])
    for (const pipe of process.extra) {
      await pipe.read?.cancel().catch(() => undefined)
      await pipe.write?.abort().catch(() => undefined)
    }
  }

  const waitForActivePort = async (profile: string): Promise<{ port: number; path: string } | null> => {
    const activePortPath = join(profile, "DevToolsActivePort")
    return poll({
      timeoutMs: 5000,
      intervalMs: 50,
      probe: async () => {
        try {
          return parseDevToolsActivePort(readFileSync(activePortPath, "utf8"))
        } catch {
          return null
        }
      },
      accept: (value) => value !== null,
    })
  }

  const activate = async (
    spawned: SpawnedChrome,
    client: CdpClient,
  ): Promise<{ client: CdpClient; process: SpawnedChrome }> => {
    await client.call("Browser.getVersion")
    active = { client, process: spawned }
    void spawned.exited.then(async () => {
      if (active?.process === spawned) {
        await client.close()
        active = null
      }
    })
    return { client, process: spawned }
  }

  const startPortFallback = async ({
    executable,
    profile,
    env,
  }: {
    executable: string
    profile: string
    env: Record<string, string>
  }): Promise<{ client: CdpClient; process: SpawnedChrome } | null> => {
    const args = deriveChromePortLaunchArgs({ profile, env })
    const spawnedResult = kernel.spawnTree({ cmd: executable, args, cwd: kernel.paths.browserDir, env })
    if (!spawnedResult.success) return null
    const spawned = spawnedResult
    void discardStream(spawned.stdout)
    void discardStream(spawned.stderr)
    let client: CdpClient | null = null
    try {
      const activePort = await waitForActivePort(profile)
      if (!activePort) throw new Error("Chrome did not create DevToolsActivePort")
      const response = await fetch(`http://127.0.0.1:${activePort.port}/json/version`)
      if (!response.ok) throw new Error(`Chrome DevTools endpoint returned ${response.status}`)
      const version = record(await response.json())
      const websocket = stringValue(version?.webSocketDebuggerUrl)
      const websocketUrl = websocket ?? `ws://127.0.0.1:${activePort.port}${activePort.path}`
      const parsed = new URL(websocketUrl)
      if (parsed.hostname !== "127.0.0.1" || parsed.port !== String(activePort.port))
        throw new Error("Chrome DevTools endpoint was not loopback-only")
      client = await connectCdpWebSocket({ url: parsed.toString(), timeoutMs: 5000 })
      return await activate(spawned, client)
    } catch {
      await client?.close()
      await stopSpawned(spawned)
      return null
    }
  }

  const start = async (): Promise<{ client: CdpClient; process: SpawnedChrome } | null> => {
    if (active && !active.client.isClosed()) return active
    if (active) {
      const stale = active
      active = null
      await stale.client.close()
      await stopSpawned(stale.process)
    }
    const executable = await chromeExecutable({ kernel, mode })
    if (!executable) return null
    const env = await environment()
    const profile = join(kernel.paths.browserDir, "profiles", "default")
    await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: profile })
    const args = deriveChromeLaunchArgs({ profile, env })
    const spawnedResult = kernel.spawnTree({ cmd: executable, args, cwd: kernel.paths.browserDir, env, extraFds: 2 })
    if (!spawnedResult.success) {
      kernel.log({
        level: "warn",
        module: "browser",
        msg: "Chrome failed to start",
        data: { error: spawnedResult.errorCode },
      })
      return startPortFallback({ executable, profile, env })
    }
    const spawned = spawnedResult
    void discardStream(spawned.stdout)
    void discardStream(spawned.stderr)
    const input = spawned.extra[0]?.write
    const output = spawned.extra[1]?.read
    if (!input || !output) {
      await stopSpawned(spawned)
      return startPortFallback({ executable, profile, env })
    }
    let client: CdpClient | null = null
    try {
      client = createCdpClient({ pipe: { read: output, write: input }, timeoutMs: 5000 })
      return await activate(spawned, client)
    } catch {
      await client?.close()
      await stopSpawned(spawned)
      return startPortFallback({ executable, profile, env })
    }
  }

  const stop = async (): Promise<void> => {
    const current = active
    active = null
    if (!current) return
    await current.client.close()
    await stopSpawned(current.process)
  }

  return { start, stop }
}
