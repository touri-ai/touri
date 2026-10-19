import { createHash, randomBytes } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import type { AbsolutePath, Result, RunErrorClass } from "@touri/contracts"
import { refineErrorClass } from "@touri/contracts/run-failure"
import { atomicWriteFile } from "../kernel/files"
import { sleep } from "../kernel/policy"
import { withToolPath } from "../kernel/shell-env"

export const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

export const numberValue = (value: unknown): number | null => (typeof value === "number" ? value : null)

export const jsonText = (value: unknown): string => JSON.stringify(value)

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = asRecord(value)
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

export const randomHexToken = (): string => randomBytes(32).toString("hex")

export const writePrivateFile = ({ root, path, content }: { root: string; path: string; content: string }): void =>
  atomicWriteFile({ root, path, content })

const findOnPath = ({ command, env }: { command: string; env: Record<string, string> }): string | null => {
  const pathValue = withToolPath(env).PATH ?? ""
  // Windows PATH uses ";" between drive-letter paths, and executables carry a PATHEXT extension (.exe, .cmd).
  if (process.platform === "win32") return Bun.which(command, { PATH: pathValue })
  for (const directory of pathValue.split(":")) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return null
}

/** A stale absolute path (the CLI moved or was reinstalled) falls back to the same binary name on PATH. */
export const resolveExecutable = ({
  command,
  env,
}: {
  command: string
  env: Record<string, string>
}): Result<{ path: AbsolutePath }, "cli_missing"> => {
  const missing = { success: false, errorCode: "cli_missing", error: `Executable not found: ${command}` } as const
  if (!isAbsolute(command)) {
    const found = findOnPath({ command, env })
    return found ? { success: true, path: found } : missing
  }
  try {
    accessSync(command, constants.X_OK)
    return { success: true, path: command }
  } catch {
    const found = findOnPath({ command: basename(command), env })
    return found ? { success: true, path: found } : missing
  }
}

export const classifyProviderError = (value: string): RunErrorClass => {
  const text = value.toLowerCase()

  if (text.includes("401") || text.includes("not logged in") || text.includes("login required")) return "cli_auth"
  if (text.includes("429") || text.includes("rate limit") || text.includes("usage limit")) return "rate_limit"
  if (text.includes("context length") || text.includes("too long") || text.includes("context window"))
    return "context_overflow"
  if (text.includes("timeout") || text.includes("timed out")) return "timeout"
  return refineErrorClass("unknown", value)
}

export const bounded = ({ value, max }: { value: string; max: number }): string =>
  value.length <= max ? value : value.slice(value.length - max)

export const delay = ({ milliseconds, signal }: { milliseconds: number; signal?: AbortSignal }): Promise<void> =>
  sleep(milliseconds, signal)
