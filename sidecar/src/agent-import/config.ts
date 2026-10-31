import { parse } from "node:path"
import { readBoundedFile } from "../kernel/files"
import { IMPORT_LIMITS, type ImportFileRead } from "./model"
import { hasSecret, isSafeText } from "./safety"

/** Runs only inside the file worker: configuration values never cross its output boundary. */
export const getImportConfig = (path: string): { names: string[]; secrets: number; bytes: number } => {
  const bytes = readBoundedFile({ root: parse(path).root, path, maxBytes: IMPORT_LIMITS.file, rejectHardlinks: true })
  const config = getParsedConfig(bytes.toString("utf8"))
  const servers = config && typeof config === "object" && "mcpServers" in config ? config.mcpServers : undefined
  const names =
    servers && typeof servers === "object" && !Array.isArray(servers)
      ? Object.keys(servers).filter((name) => /^[\p{L}\p{N} _.-]{1,80}$/u.test(name) && isSafeText(name))
      : []

  return { names, secrets: getSecretCount(config), bytes: bytes.byteLength }
}

const getSecretCount = (value: unknown, depth = 0): number => {
  if (depth > 10) return 1
  if (typeof value === "string") return hasSecret(value) ? 1 : 0
  if (!value || typeof value !== "object") return 0

  return Object.entries(value).reduce((count, [key, item]) => {
    if (/token|password|secret|api[_-]?key|credential|authorization|oauth|^auth$|^env$/i.test(key)) return count + 1

    return count + getSecretCount(item, depth + 1)
  }, 0)
}

/** Reject text before the worker can return it to the preview builder. */
export const getImportFile = (path: string): ImportFileRead => {
  const bytes = readBoundedFile({ root: parse(path).root, path, maxBytes: IMPORT_LIMITS.file, rejectHardlinks: true })
  if (bytes.includes(0)) return { kind: "excluded", bytes: bytes.byteLength }
  const content = bytes.toString("utf8")
  if (hasSecret(content)) return { kind: "secret", bytes: bytes.byteLength }
  if (!isSafeText(content)) return { kind: "excluded", bytes: bytes.byteLength }

  return { kind: "file", content, bytes: bytes.byteLength }
}

const getParsedConfig = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch {
    throw new Error("INVALID_ARGS")
  }
}
