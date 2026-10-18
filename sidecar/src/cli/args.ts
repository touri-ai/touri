import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DEPRECATED_IMPORT_ALIAS } from "../importer/deprecatedAliases"
import { validProviderProfileName } from "../kernel/provider-profiles"

export const defaultPort = 8795
export const defaultHost = "127.0.0.1"
export const defaultDrainTimeoutMs = 60_000
export const tailscaleHttpsPort = 8445

export type ServeOptions = {
  port: number
  drainTimeoutMs: number
  host: string
  dataDir: string
  tailscale: boolean
  noPair: boolean
  uiDir: string | null
  trustedProxy?: boolean
}

export type CliCommand =
  | { name: "serve"; options: ServeOptions }
  | {
      name: "pair"
      dataDir: string
      client: boolean
      printToken: boolean
      url: string | null
      code: string | null
      port: number
    }
  | { name: "status"; dataDir: string; port: number }
  | { name: "doctor"; dataDir: string; port: number }
  | { name: "devices"; dataDir: string; revokeId: string | null }
  | { name: "import-legacy"; dataDir: string; path: string; dryRun: boolean; importCodexSessions: boolean }
  | { name: "mcp-stdio"; threadId: string; dataDir: string }
  | { name: "profile-list"; dataDir: string }
  | { name: "profile-login"; dataDir: string; profile: string; provider: "claude" | "codex" }
  | { name: "version" }
  | { name: "help" }

export type ParseCliSuccess = { success: true; command: CliCommand }
export type ParseCliError = { success: false; error: string }
export type ParseCliResult = ParseCliSuccess | ParseCliError

type FlagKind = "boolean" | "value"

const flagKinds: Record<string, FlagKind> = {
  "--port": "value",
  "--drain-timeout": "value",
  "--host": "value",
  "--data-dir": "value",
  "--ui-dir": "value",
  "--url": "value",
  "--code": "value",
  "--path": "value",
  "--thread": "value",
  "--provider": "value",
  "--tailscale": "boolean",
  "--trust-proxy": "boolean",
  "--no-pair": "boolean",
  "--client": "boolean",
  "--print-token": "boolean",
  "--dry-run": "boolean",
  "--import-codex-sessions": "boolean",
  "--help": "boolean",
  "-h": "boolean",
  "--version": "boolean",
  "-v": "boolean",
}

type Flags = { values: Record<string, string>; switches: Set<string>; positionals: Array<string> }
type FlagsResult = { success: true; flags: Flags } | ParseCliError

const parseFlags = (args: Array<string>): FlagsResult => {
  const values: Record<string, string> = {}
  const switches = new Set<string>()
  const positionals: Array<string> = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (!arg.startsWith("-")) {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf("=")
    const name = equals > 0 ? arg.slice(0, equals) : arg
    const kind = flagKinds[name]
    if (kind === undefined) return { success: false, error: `Unknown option ${name}` }
    if (kind === "boolean") {
      switches.add(name)
      continue
    }
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined
    const next = inline ?? args[index + 1]
    if (next === undefined || (inline === undefined && next.startsWith("--")))
      return { success: false, error: `Option ${name} needs a value` }
    values[name] = next
    if (inline === undefined) index += 1
  }
  return { success: true, flags: { values, switches, positionals } }
}

/** Expands a leading `~` to the home directory. */
export const expandHome = (value: string, home: string = homedir()): string => {
  if (value === "~") return home
  if (value.startsWith("~/")) return join(home, value.slice(2))
  return value
}

const parsePort = (raw: string | undefined): { success: true; port: number } | ParseCliError => {
  if (raw === undefined) return { success: true, port: defaultPort }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { success: false, error: `Invalid port ${raw}; use 1-65535` }
  return { success: true, port }
}

const parseDrainTimeout = (raw: string | undefined): { success: true; timeoutMs: number } | ParseCliError => {
  if (raw === undefined) return { success: true, timeoutMs: defaultDrainTimeoutMs }
  if (!/^\d+$/.test(raw)) return { success: false, error: "Invalid drain timeout; use 1-600 seconds" }
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    return { success: false, error: "Invalid drain timeout; use 1-600 seconds" }

  return { success: true, timeoutMs: seconds * 1000 }
}

// Absolute, so the TOURI_APP_DATA that `serve` exports still resolves from the bots' workspace cwd.
const dataDirOf = (flags: Flags): string => resolve(expandHome(flags.values["--data-dir"] ?? "~/.touri"))

const buildServe = (flags: Flags): ParseCliResult => {
  const port = parsePort(flags.values["--port"])
  if (!port.success) return port
  const drainTimeout = parseDrainTimeout(flags.values["--drain-timeout"])
  if (!drainTimeout.success) return drainTimeout
  const uiDir = flags.values["--ui-dir"]
  return {
    success: true,
    command: {
      name: "serve",
      options: {
        port: port.port,
        drainTimeoutMs: drainTimeout.timeoutMs,
        host: flags.values["--host"] ?? defaultHost,
        dataDir: dataDirOf(flags),
        tailscale: flags.switches.has("--tailscale"),
        ...(flags.switches.has("--trust-proxy") ? { trustedProxy: true } : {}),
        noPair: flags.switches.has("--no-pair"),
        uiDir: uiDir === undefined ? null : expandHome(uiDir),
      },
    },
  }
}

const buildPair = (flags: Flags): ParseCliResult => {
  const port = parsePort(flags.values["--port"])
  if (!port.success) return port
  if (flags.switches.has("--print-token") && !flags.switches.has("--client"))
    return { success: false, error: "--print-token requires pair --client" }
  return {
    success: true,
    command: {
      name: "pair",
      dataDir: dataDirOf(flags),
      client: flags.switches.has("--client"),
      printToken: flags.switches.has("--print-token"),
      url: flags.values["--url"] ?? null,
      code: flags.values["--code"] ?? null,
      port: port.port,
    },
  }
}

const buildImport = (flags: Flags): ParseCliResult => {
  const [, target] = flags.positionals
  if (target !== "legacy" && target !== DEPRECATED_IMPORT_ALIAS)
    return { success: false, error: "Usage: touri import legacy --path <dir> [--dry-run]" }
  const path = flags.values["--path"]
  if (path === undefined) return { success: false, error: "touri import legacy needs --path <legacy app dir>" }
  return {
    success: true,
    command: {
      name: "import-legacy",
      dataDir: dataDirOf(flags),
      path: expandHome(path),
      dryRun: flags.switches.has("--dry-run"),
      importCodexSessions: flags.switches.has("--import-codex-sessions"),
    },
  }
}

const buildDevices = (flags: Flags): ParseCliResult => {
  const [, action, id] = flags.positionals
  if (action !== undefined && action !== "revoke")
    return { success: false, error: "Usage: touri devices [revoke <id>]" }
  if (action === "revoke" && id === undefined)
    return { success: false, error: "touri devices revoke needs a device id" }
  return { success: true, command: { name: "devices", dataDir: dataDirOf(flags), revokeId: id ?? null } }
}

const buildProfile = (flags: Flags): ParseCliResult => {
  const [, action, profile] = flags.positionals
  if (action === "list" || action === undefined)
    return { success: true, command: { name: "profile-list", dataDir: dataDirOf(flags) } }
  if (action !== "login")
    return { success: false, error: "Usage: touri profile list | login <name> [--provider claude]" }
  if (!validProviderProfileName(profile))
    return { success: false, error: "touri profile login needs a name: letters, digits, dot, dash or underscore" }
  const provider = flags.values["--provider"] ?? "claude"
  if (provider !== "claude" && provider !== "codex")
    return { success: false, error: "--provider must be claude or codex" }
  return { success: true, command: { name: "profile-login", dataDir: dataDirOf(flags), profile, provider } }
}

const buildWithPort = (flags: Flags, name: "status" | "doctor"): ParseCliResult => {
  const port = parsePort(flags.values["--port"])
  if (!port.success) return port
  return { success: true, command: { name, dataDir: dataDirOf(flags), port: port.port } }
}

/** Parses `process.argv.slice(2)` into a typed command. */
export const parseCli = (
  argv: Array<string>,
  env: Record<string, string | undefined> = process.env,
): ParseCliResult => {
  const parsed = parseFlags(argv)
  if (!parsed.success) return parsed
  const { flags } = parsed
  if (flags.switches.has("--version") || flags.switches.has("-v"))
    return { success: true, command: { name: "version" } }
  const [command] = flags.positionals
  if (command === undefined || flags.switches.has("--help") || flags.switches.has("-h") || command === "help")
    return { success: true, command: { name: "help" } }
  if (command === "serve") return buildServe(flags)
  if (command === "pair") return buildPair(flags)
  if (command === "status") return buildWithPort(flags, "status")
  if (command === "doctor") return buildWithPort(flags, "doctor")
  if (command === "devices") return buildDevices(flags)
  if (command === "import") return buildImport(flags)
  if (command === "profile") return buildProfile(flags)
  if (command === "version") return { success: true, command: { name: "version" } }
  if (command === "mcp-stdio") {
    const threadId = flags.values["--thread"]
    if (threadId === undefined) return { success: false, error: "mcp-stdio needs --thread <id>" }
    // The runtime launches the shim with TOURI_APP_DATA, not --data-dir, so a server on a custom data dir is found.
    const dataDir =
      flags.values["--data-dir"] === undefined && env.TOURI_APP_DATA ? env.TOURI_APP_DATA : dataDirOf(flags)
    return { success: true, command: { name: "mcp-stdio", threadId, dataDir } }
  }
  return { success: false, error: `Unknown command ${command}` }
}

export const usageText = `touri - run your touri bots headless

Usage:
  touri serve [--port 8795] [--host 127.0.0.1] [--data-dir ~/.touri] [--drain-timeout 60] [--tailscale | --trust-proxy] [--no-pair] [--ui-dir <dir>]
  touri pair [--data-dir <dir>]                     print a one-time pairing code (valid 5 minutes)
  touri pair --client [--url <url>] [--code <code>] [--print-token]
                                                  pair this CLI; optionally print only the device token
  touri devices [revoke <id>]                       list or revoke paired devices
  touri status [--data-dir <dir>]
  touri doctor [--data-dir <dir>]
  touri import legacy --path <dir> [--dry-run] [--import-codex-sessions]
  touri profile list                                 list provider login profiles and their accounts
  touri profile login <name> [--provider claude|codex]
                                                  sign a profile in with the official CLI login; pick it per bot
  touri version
`
