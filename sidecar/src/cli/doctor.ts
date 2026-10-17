import { accessSync, constants, existsSync, statSync } from "node:fs"
import { arch, homedir, platform } from "node:os"
import { join } from "node:path"
import { createAppPaths, resolveMcpSocketPath } from "../kernel/paths"
import { createAppleContainerProvider } from "../vm"
import type { CliCommand } from "./args"
import { computerUseDisabledReason } from "./host/headlessHost"
import { runCommand } from "./tailscale"
import { cliVersion } from "./version"
import { resolveUiAssets } from "./web/uiAssets"

export type DoctorLevel = "ok" | "warn" | "fail"
export type DoctorCheck = { name: string; level: DoctorLevel; detail: string }

const toolCheck = async (name: string, args: Array<string>, required: boolean, binary = name): Promise<DoctorCheck> => {
  const result = await runCommand(binary, args)
  if (result.code === 0) return { name, level: "ok", detail: result.stdout.trim().split("\n")[0] ?? "" }
  return { name, level: required ? "fail" : "warn", detail: "not found on PATH" }
}

const dataDirCheck = (dataDir: string): DoctorCheck => {
  if (!existsSync(dataDir))
    return { name: "data dir", level: "warn", detail: `${dataDir} does not exist yet (created by serve)` }
  try {
    accessSync(dataDir, constants.W_OK)
    const mode = statSync(dataDir).mode & 0o777
    return { name: "data dir", level: mode & 0o077 ? "warn" : "ok", detail: `${dataDir} (mode ${mode.toString(8)})` }
  } catch {
    return { name: "data dir", level: "fail", detail: `${dataDir} is not writable` }
  }
}

export const socketPathCheck = (dataDir: string): DoctorCheck => {
  const paths = createAppPaths({ appData: dataDir })
  const path = resolveMcpSocketPath(paths)
  const fallback = path !== join(paths.runDir, "mcp.sock")
  return {
    name: "mcp socket path",
    level: "ok",
    detail: fallback
      ? `${Buffer.byteLength(path)} bytes; using a short private temporary socket directory because the data dir path is too long`
      : `${Buffer.byteLength(path)} bytes`,
  }
}

const portCheck = async (port: number): Promise<DoctorCheck> => {
  const reachable = await fetch(`http://127.0.0.1:${port}/pair`, { signal: AbortSignal.timeout(1500) })
    .then((response) => response.ok)
    .catch(() => false)
  return {
    name: "server port",
    level: "ok",
    detail: reachable ? `touri answers on ${port}` : `${port} is free or not touri`,
  }
}

export const collectDoctorChecks = async ({
  dataDir,
  port,
}: {
  dataDir: string
  port: number
}): Promise<Array<DoctorCheck>> => {
  const ui = resolveUiAssets({ uiDir: null })
  const tools = await Promise.all([
    toolCheck("codex", ["--version"], false),
    toolCheck("claude", ["--version"], false),
    toolCheck(
      "OpenCode",
      ["--version"],
      false,
      existsSync(join(homedir(), ".opencode/bin/opencode")) ? join(homedir(), ".opencode/bin/opencode") : "opencode",
    ),
    toolCheck("git", ["--version"], true),
    toolCheck("tailscale", ["version"], false),
  ])
  return [
    { name: "touri", level: "ok", detail: `${cliVersion} ${platform()}-${arch()}` },
    dataDirCheck(dataDir),
    socketPathCheck(dataDir),
    {
      name: "ui bundle",
      level: ui.source === "none" ? "warn" : "ok",
      detail: ui.source === "none" ? "not embedded; pass --ui-dir to serve" : "embedded",
    },
    {
      name: "secrets",
      level: "ok",
      detail: existsSync(join(dataDir, "secrets.enc"))
        ? "encrypted file present"
        : "encrypted file is created on first use",
    },
    { name: "computer use", level: "warn", detail: computerUseDisabledReason },
    await portCheck(port),
    ...tools,
    ...(await createAppleContainerProvider().doctor()).map((check) => ({
      name: check.id,
      level: check.ok ? ("ok" as const) : ("warn" as const),
      detail: check.detail,
    })),
  ]
}

export const runDoctor = async (command: Extract<CliCommand, { name: "doctor" }>): Promise<number> => {
  const checks = await collectDoctorChecks({ dataDir: command.dataDir, port: command.port })
  for (const check of checks) process.stdout.write(`[${check.level}] ${check.name}: ${check.detail}\n`)
  return checks.some((check) => check.level === "fail") ? 1 : 0
}
