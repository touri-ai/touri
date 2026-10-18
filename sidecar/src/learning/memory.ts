import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { findThreat } from "./threats"

export type MemoryTarget = "memory" | "user"
export type MemoryOperation = { action: "add" | "patch" | "remove"; content?: string; old_text?: string }

/** Entries are separated by a line holding only §, so one entry can span several lines. */
export const ENTRY_DELIMITER = "\n§\n"
export const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 3_000, user: 1_500 }
export const memoryFile = (homeDir: string, target: MemoryTarget): string =>
  join(homeDir, target === "memory" ? "MEMORY.md" : "USER.md")

export const parseEntries = (text: string): string[] => {
  const seen = new Set<string>()
  return text
    .split(/\n§\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
}

export const renderEntries = (entries: string[]): string => entries.join(ENTRY_DELIMITER)

export const readEntries = (homeDir: string, target: MemoryTarget): string[] => {
  try {
    return parseEntries(readFileSync(memoryFile(homeDir, target), "utf8"))
  } catch {
    return []
  }
}

export const writeEntries = (homeDir: string, target: MemoryTarget, entries: string[]): void => {
  const path = memoryFile(homeDir, target)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, entries.length ? `${renderEntries(entries)}\n` : "", { mode: 0o600 })
  renameSync(temporary, path)
}

export type MemoryResult =
  | { success: true; entries: string[]; changed: boolean }
  | { success: false; errorCode: string; error: string; entries: string[] }

const matching = (entries: string[], text: string): number[] =>
  entries.flatMap((entry, index) => (entry.includes(text) ? [index] : []))

/** Applies every operation or none; the size limit is checked only on the final result. */
export const applyMemoryOperations = ({
  entries,
  operations,
  limit,
}: {
  entries: string[]
  operations: MemoryOperation[]
  limit: number
}): MemoryResult => {
  const next = [...entries]
  const failure = (errorCode: string, error: string): MemoryResult => ({ success: false, errorCode, error, entries })
  for (const [position, operation] of operations.entries()) {
    const label = `Operação ${position + 1}`
    const content = operation.content?.trim() ?? ""
    const oldText = operation.old_text?.trim() ?? ""
    if (operation.action !== "remove") {
      if (!content) return failure("INVALID_ARGS", `${label}: informe content.`)
      const threat = findThreat(content, "memory")
      if (threat) return failure("UNSAFE_CONTENT", `${label} recusada: ${threat}.`)
      if (content.includes("\n§\n") || content === "§")
        return failure("INVALID_ARGS", `${label}: o separador § não pode aparecer sozinho numa linha.`)
    }
    if (operation.action === "add") {
      if (!next.includes(content)) next.push(content)
      continue
    }
    if (!oldText) return failure("INVALID_ARGS", `${label}: informe old_text com um trecho de uma entrada.`)
    const found = matching(next, oldText)
    if (found.length === 0) return failure("NO_MATCH", `${label}: nenhuma entrada contém o trecho informado.`)
    if (found.length > 1)
      return failure("AMBIGUOUS_MATCH", `${label}: ${found.length} entradas contêm o trecho; use um trecho mais longo.`)
    const index = found[0] as number
    if (operation.action === "remove") next.splice(index, 1)
    else {
      const replaced = (next[index] as string).replace(oldText, content).trim()
      if (next.some((entry, other) => other !== index && entry === replaced)) next.splice(index, 1)
      else next[index] = replaced
    }
  }
  const size = renderEntries(next).length
  if (size > limit)
    return failure(
      "MEMORY_FULL",
      `O resultado teria ${size} caracteres e o limite é ${limit}. Envie uma única chamada que remova ou encurte entradas e adicione o novo fato.`,
    )
  return { success: true, entries: next, changed: JSON.stringify(next) !== JSON.stringify(entries) }
}

export const memoryUsage = (entries: string[], target: MemoryTarget): string =>
  `${renderEntries(entries).length}/${MEMORY_LIMITS[target]}`
