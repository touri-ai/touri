import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { win32 } from "node:path"
import type { Kernel } from "@touri/contracts"
import { defaultShell, extraToolDirectories } from "../platform/posix"
import { withDeadline } from "./policy"
import { discardStream } from "./streams"

const childEnvBlocked = (key: string): boolean => {
  const upper = key.toUpperCase()
  if (upper === "TOURI_UI_TOKEN" || upper === "TOURI_HOST_TOKEN" || upper === "TOURI_HOST_SOCK") return true
  if (upper === "TOURI_PARENT_PID") return true
  if (upper.startsWith("TOURI_") && /(TOKEN|AUTH|SOCK|SOCKET|PASSWORD|SECRET|CREDENTIAL|API_KEY)/.test(upper))
    return true
  return /^MCP_(TOKEN|AUTH|SECRET|CREDENTIAL)/.test(upper)
}

export const buildChildEnv = ({
  base = process.env,
  overrides = {},
}: {
  base?: NodeJS.ProcessEnv | Record<string, string>
  overrides?: NodeJS.ProcessEnv | Record<string, string>
} = {}): Record<string, string> => {
  const merged = { ...base, ...overrides }
  return Object.fromEntries(
    Object.entries(merged).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !childEnvBlocked(entry[0]),
    ),
  )
}

const SHELL_ENV_TIMEOUT_MS = 8000

export const parseEnvOutput = ({ output, marker }: { output: string; marker: string }): Record<string, string> => {
  const markerIndex = output.indexOf(`\0${marker}\0`)
  const environment = markerIndex >= 0 ? output.slice(markerIndex + marker.length + 2) : output
  const parsed: Record<string, string> = {}
  for (const item of environment.split("\0")) {
    const separator = item.indexOf("=")
    if (separator > 0) parsed[item.slice(0, separator)] = item.slice(separator + 1)
  }
  return parsed
}

const toolDirectories = ({
  home,
  exists,
  platform,
}: {
  home: string
  exists: (path: string) => boolean
  platform: string
}): Array<string> => {
  if (platform === "win32")
    return [
      win32.join(home, ".local", "bin"),
      win32.join(home, ".bun", "bin"),
      win32.join(home, ".cargo", "bin"),
      win32.join(process.env.APPDATA || win32.join(home, "AppData", "Roaming"), "npm"),
    ].filter(exists)
  const nvmRoot = `${home}/.nvm/versions/node`
  const nvmBins = exists(nvmRoot)
    ? readdirSync(nvmRoot)
        .sort()
        .reverse()
        .map((version) => `${nvmRoot}/${version}/bin`)
    : []
  return [
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.opencode/bin`,
    `${home}/.volta/bin`,
    `${home}/.local/share/mise/shims`,
    `${home}/.asdf/shims`,
    `${home}/.cargo/bin`,
    ...nvmBins,
    ...extraToolDirectories,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((directory) => exists(directory))
}

export const mergePath = ({
  path,
  home,
  exists = existsSync,
  platform = process.platform,
}: {
  path: string | undefined
  home: string
  exists?: (path: string) => boolean
  platform?: string
}): string => {
  const delimiter = platform === "win32" ? ";" : ":"
  const existing = (path ?? "").split(delimiter).filter((entry) => entry.length > 0)
  const merged = [...existing, ...toolDirectories({ home, exists, platform })]
  return merged
    .filter(
      (entry, index) =>
        merged.findIndex((other) =>
          platform === "win32" ? other.toLowerCase() === entry.toLowerCase() : other === entry,
        ) === index,
    )
    .join(delimiter)
}

// Use the same tool directories for discovery and execution, including Finder launches.
export const withToolPath = (
  environment: NodeJS.ProcessEnv | Record<string, string> = process.env,
): Record<string, string> & { PATH: string } => {
  const result = buildChildEnv({ base: environment })
  const pathKey =
    process.platform === "win32" ? (Object.keys(result).find((key) => key.toUpperCase() === "PATH") ?? "PATH") : "PATH"
  const path = result[pathKey] ?? process.env.PATH
  if (pathKey !== "PATH") delete result[pathKey]
  return { ...result, PATH: mergePath({ path, home: result.HOME ?? result.USERPROFILE ?? homedir() }) }
}

export const createShellEnv = ({ spawn, shell }: { spawn: Kernel["spawnTree"]; shell?: string }) => {
  let pending: Promise<Record<string, string>> | null = null
  let activeChild: Extract<ReturnType<Kernel["spawnTree"]>, { success: true }> | null = null
  let disposed = false

  const load = async (): Promise<Record<string, string>> => {
    if (process.platform === "win32") return withToolPath(process.env)
    const marker = "__TOURI_ENV__"
    const child = spawn({
      cmd: shell ?? process.env.SHELL ?? defaultShell,
      args: ["-ilc", `printf '\\0${marker}\\0'; env -0`],
      cwd: process.cwd(),
      env: buildChildEnv(),
    })
    if (!child.success) return withToolPath(process.env)
    activeChild = child
    void discardStream(child.stderr)
    try {
      const output = await withDeadline({
        operation: () => new Response(child.stdout).text(),
        timeoutMs: SHELL_ENV_TIMEOUT_MS,
      })
      return withToolPath({ ...process.env, ...parseEnvOutput({ output, marker }) })
    } catch {
      child.kill("SIGTERM")
      return withToolPath(process.env)
    } finally {
      activeChild = null
    }
  }

  const shellEnv = async (): Promise<Record<string, string>> => {
    if (disposed) return withToolPath(process.env)
    pending ??= load()
    return { ...(await pending) }
  }

  const dispose = (): void => {
    disposed = true
    activeChild?.kill("SIGTERM")
    activeChild = null
  }

  return { shellEnv, dispose }
}
