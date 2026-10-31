import { access, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { errorRegistry } from "@touri/contracts/errors"
import { buildChildEnv } from "../kernel"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import { poll } from "../kernel/policy"
import { discardStream } from "../kernel/streams"
import { connectCdpWebSocket, createCdpClient } from "./cdp"
import { startBrowserDisplay } from "./display"
import { BrowserSandboxUnavailableError, startChromeSandboxDiagnostic } from "./sandbox"
import type { CdpClient } from "./types"

type SpawnedChrome = Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>

export const getChromeExitCause = (
  exit: { code: number | null; signal: string | null } | null,
): "memory" | "crash" | null => {
  if (!exit) return null
  if (exit.code === 137 || exit.signal === "SIGKILL") return "memory"
  return exit.code === 0 ? null : "crash"
}

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
  platform?: string
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
    ...(env.TOURI_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ...(env.TOURI_BROWSER_DISABLE_DEV_SHM_USAGE === "1" ? ["--disable-dev-shm-usage"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    ...deriveChromeWindowArgs({ env }),
    "--remote-debugging-pipe",
    "about:blank",
  ]
}

export const deriveChromePortLaunchArgs = ({
  profile,
  port,
  env = process.env,
}: {
  profile: string
  env?: Record<string, string | undefined>
  port: number
}): Array<string> => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Chrome debugging port")
  const pipeArgs = deriveChromeLaunchArgs({ profile, env })
  const pipeIndex = pipeArgs.indexOf("--remote-debugging-pipe")
  if (pipeIndex < 0) return pipeArgs
  return [
    ...pipeArgs.slice(0, pipeIndex),
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
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
  timeoutMs = 30_000,
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
        const lines = (await readFile(join(dataDir, "DevToolsActivePort"), "utf8")).split(/\r?\n/)
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
  env,
}: {
  kernel: Kernel
  mode: "system-chrome" | "chrome-for-testing"
  env: Record<string, string | undefined>
}): Promise<string | null> => {
  if (process.platform !== "darwin") {
    // Use stable system Chrome; managed browsing never substitutes a testing build.
    return (
      env.TOURI_CHROME_BIN ??
      ((await access("/opt/google/chrome/chrome").then(
        () => true,
        () => false,
      ))
        ? "/opt/google/chrome/chrome"
        : Bun.which("google-chrome"))
    )
  }
  if (
    mode === "system-chrome" &&
    (await access(systemChrome).then(
      () => true,
      () => false,
    ))
  )
    return systemChrome
  if (mode === "system-chrome") return null
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
  createClient = createCdpClient,
  botId,
  env: suppliedEnv = process.env,
}: {
  kernel: Kernel
  mode?: "system-chrome" | "chrome-for-testing"
  createClient?: typeof createCdpClient
  botId?: string
  env?: Record<string, string | undefined>
}): ChromeLauncher => {
  let active: { client: CdpClient; process: SpawnedChrome } | null = null
  let pending: ReturnType<ChromeLauncher["start"]> | null = null
  let stopping: Promise<void> | null = null
  let generation = 0
  let display: Awaited<ReturnType<typeof startBrowserDisplay>> = null

  const environment = async (): Promise<Record<string, string>> => {
    return buildChildEnv({ base: await kernel.shellEnv(), overrides: suppliedEnv })
  }

  const stopSpawned = async (process: SpawnedChrome): Promise<void> => {
    process.kill("SIGTERM")
    const timer = setTimeout(() => process.kill("SIGKILL"), 2000)
    try {
      // The profile remains owned until the OS reports exit, even after escalation.
      await process.exited
    } finally {
      clearTimeout(timer)
    }
    for (const pipe of process.extra) {
      await pipe.read?.cancel().catch(() => undefined)
      await pipe.write?.abort().catch(() => undefined)
    }
  }

  const activate = async (
    spawned: SpawnedChrome,
    client: CdpClient,
  ): Promise<{ client: CdpClient; process: SpawnedChrome }> => {
    // Bound startup without shortening later navigation, screenshots or evaluations.
    const timer = setTimeout(() => void client.close().catch(() => undefined), 3000)
    try {
      await client.call("Browser.getVersion")
    } finally {
      clearTimeout(timer)
    }
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
    const port = await getChromeDebugPort()
    const args = deriveChromePortLaunchArgs({ profile, env, port })
    const spawnedResult = kernel.spawnTree({ cmd: executable, args, cwd: kernel.paths.browserDir, env })
    if (!spawnedResult.success) return null
    const spawned = spawnedResult
    void discardStream(spawned.stdout)
    const sandboxDenied = startChromeSandboxDiagnostic(spawned.stderr)
    let client: CdpClient | null = null
    try {
      const ready = await poll({
        timeoutMs: 5000,
        intervalMs: 50,
        probe: async () => {
          if (await Promise.race([spawned.exited.then(() => true), Bun.sleep(0).then(() => false)])) return null
          return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then(
            (response) => (response.ok ? response : null),
            () => null,
          )
        },
        accept: (response) => response !== null,
      })
      if (!ready) throw new Error("Chrome did not open its debugging endpoint")
      const version = record(await ready.json())
      const websocketUrl = stringValue(version?.webSocketDebuggerUrl)
      if (!websocketUrl) throw new Error("Chrome debugging endpoint is missing")
      const parsed = new URL(websocketUrl)
      if (parsed.hostname !== "127.0.0.1" || parsed.port !== String(port))
        throw new Error("Chrome DevTools endpoint was not loopback-only")
      client = await connectCdpWebSocket({ url: parsed.toString(), connectTimeoutMs: 3000 })
      return await activate(spawned, client)
    } catch {
      const exit = await Promise.race([spawned.exited, Bun.sleep(0).then(() => null)])
      await client?.close()
      await stopSpawned(spawned)
      if (await sandboxDenied()) throw new BrowserSandboxUnavailableError()
      if (getChromeExitCause(exit) === "memory") throw new Error("Browser process terminated: possible out of memory")
      if (getChromeExitCause(exit) === "crash") throw new Error(`Browser process crashed (exit ${exit?.code})`)
      return null
    }
  }

  const launch = async (): Promise<{ client: CdpClient; process: SpawnedChrome } | null> => {
    if (active && !active.client.isClosed()) return active
    if (active) {
      const stale = active
      active = null
      await stale.client.close()
      await stopSpawned(stale.process)
    }
    const baseEnv = await environment()
    const executable = await chromeExecutable({ kernel, mode, env: baseEnv })
    if (!executable) return null
    if (
      process.platform === "linux" &&
      !baseEnv.DISPLAY &&
      !baseEnv.WAYLAND_DISPLAY &&
      !deriveChromeWindowConfig({ env: baseEnv }).headless
    ) {
      display ??= await startBrowserDisplay(kernel, baseEnv)
      if (!display) return null
    }
    const env = display?.env ?? baseEnv
    const profile = getChromeProfilePath(kernel.paths, botId)
    await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: profile })
    // Pipe transport enables Chrome's automation runtime; the normal debugging port preserves native defaults.
    if (botId) return startPortFallback({ executable, profile, env })
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
    const sandboxDenied = startChromeSandboxDiagnostic(spawned.stderr)
    const input = spawned.extra[0]?.write
    const output = spawned.extra[1]?.read
    if (!input || !output) {
      await stopSpawned(spawned)
      if (await sandboxDenied()) throw new BrowserSandboxUnavailableError()
      return startPortFallback({ executable, profile, env })
    }
    let client: CdpClient | null = null
    try {
      client = createClient({ pipe: { read: output, write: input } })
      return await activate(spawned, client)
    } catch {
      const exit = await Promise.race([spawned.exited, Bun.sleep(0).then(() => null)])
      await client?.close()
      await stopSpawned(spawned)
      if (await sandboxDenied()) throw new BrowserSandboxUnavailableError()
      if (getChromeExitCause(exit) === "memory") throw new Error("Browser process terminated: possible out of memory")
      return startPortFallback({ executable, profile, env })
    }
  }

  const stopActiveChrome = async (current: NonNullable<typeof active>): Promise<void> => {
    // Closing Chrome normally flushes cookies, local storage and the rest of the persistent profile.
    const timer = setTimeout(() => {
      void current.client.close().catch(() => undefined)
      current.process.kill("SIGTERM")
    }, 3000)
    try {
      await current.client.call("Browser.close").catch(() => undefined)
      await Promise.race([current.process.exited, Bun.sleep(3000)])
    } finally {
      clearTimeout(timer)
      await current.client.close()
      await stopSpawned(current.process)
    }
  }

  const stop = (): Promise<void> => {
    if (stopping) return stopping
    generation += 1
    const current = active
    active = null
    const starting = pending
    stopping = (async () => {
      if (current) await stopActiveChrome(current)
      // A canceled startup still owns its process and display until its cleanup finishes.
      await starting?.catch(() => undefined)
      await display?.stop()
      display = null
    })().finally(() => {
      stopping = null
    })
    return stopping
  }

  const start: ChromeLauncher["start"] = ({ runningOnly = false } = {}) => {
    if (stopping) return stopping.then(() => start({ runningOnly }))
    if (runningOnly && !active && !pending) return Promise.resolve(null)
    if (pending) return pending
    const epoch = generation
    // One launch owns the profile, including fallback and cancellation cleanup.
    pending = launch()
      .then(async (started) => {
        if (epoch === generation) return started
        if (started) {
          if (active?.process === started.process) active = null
          await Promise.all([started.client.close(), stopSpawned(started.process)])
        }
        return null
      })
      .finally(async () => {
        pending = null
        if (!active) {
          await display?.stop()
          display = null
        }
      })
    return pending
  }

  return { start, stop }
}

export const getChromeProfilePath = (
  paths: Pick<Kernel["paths"], "botsDir" | "browserDir">,
  botId?: string,
): string => {
  if (botId === undefined) return join(paths.browserDir, "profiles", "default")
  if (!/^[A-Za-z0-9_-]+$/u.test(botId)) throw new Error("Invalid browser bot ID")

  return join(paths.botsDir, botId, "browser", "profile")
}

const getChromeDebugPort = (): Promise<number> =>
  new Promise((accept, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not reserve a Chrome debugging port"))
        return
      }
      server.close((error) => (error ? reject(error) : accept(address.port)))
    })
  })
