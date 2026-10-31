import { lstat, opendir, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { AgentImportSourceKind } from "@touri/contracts"
import { getAgentImportConfigAsync, getAgentImportFileAsync } from "../kernel/async-files"
import { yieldBackground } from "../kernel/background-task"
import { getRecord, getRoutine } from "./manual"
import { IMPORT_LIMITS, type ImportAgent, type ImportRoutine, type ImportSkill, type ImportSnapshot } from "./model"
import { isSafeRelativePath, isSafeText, isSecretPath } from "./safety"

type SourceFile = { path: string; content: string }

export const getFolderSnapshot = async ({
  path,
  source,
  appData,
  signal,
}: {
  path: string
  source: AgentImportSourceKind
  appData: string
  signal: AbortSignal
}): Promise<ImportSnapshot> => {
  const root = await getSourceRoot(path, appData)
  const result = await getSourceFiles(root, source, await realpath(appData), signal)
  const globalConfig =
    source === "claude-code" ? await getGlobalConfig(root, result.bytes) : { names: [], secrets: 0, files: 0 }
  const projects = Array.from(
    new Set(
      result.files.flatMap((file) => {
        const match = /^projects\/([^/]+)\/(?:CLAUDE\.md|memory\/.*\.md)$/i.exec(file.path)
        return match?.[1] ? [match[1]] : []
      }),
    ),
  )
  if (projects.length > IMPORT_LIMITS.agents) throw new Error("INVALID_ARGS")
  // Sort a bounded local copy; directory enumeration order is not stable.
  const orderedProjects = Array.from(projects).sort()
  const agents = (orderedProjects.length ? orderedProjects : [""]).map((project, index) =>
    getFolderAgent(result.files, project, index, source),
  )

  return {
    source,
    agents: agents.map((agent) => ({
      ...agent,
      integrations: Array.from(new Set([...agent.integrations, ...globalConfig.names])),
    })),
    excluded: {
      secrets: result.excluded.secrets + globalConfig.secrets,
      files: result.excluded.files + globalConfig.files,
    },
  }
}

const getSourceRoot = async (path: string, appData: string): Promise<string> => {
  if (!isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path) || path.split(sep).includes(".."))
    throw new Error("INVALID_ARGS")
  const entry = await lstat(resolve(path))
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("INVALID_ARGS")
  // Resolve parent aliases before checking scope; subsequent reads pin the canonical ancestors.
  const canonical = await realpath(path)
  if (canonical === sep) throw new Error("INVALID_ARGS")
  const relation = relative(await realpath(appData), canonical)
  if (!relation || (!relation.startsWith(`..${sep}`) && !isAbsolute(relation))) throw new Error("INVALID_ARGS")
  if (isSecretPath(path) || isSecretPath(canonical)) throw new Error("INVALID_ARGS")

  return canonical
}

const getSourceFiles = async (root: string, source: AgentImportSourceKind, appData: string, signal: AbortSignal) => {
  // Traversal state is local; bounded async reads yield between entries and stop at the first budget limit.
  let entries = 0
  let bytes = 0
  let secrets = 0
  let excludedFiles = 0
  const started = performance.now()
  const visit = async (directory: string, depth: number): Promise<SourceFile[]> => {
    const relativeToApp = relative(appData, join(root, directory))
    if (!relativeToApp || (!relativeToApp.startsWith(`..${sep}`) && !isAbsolute(relativeToApp))) {
      excludedFiles += 1
      return []
    }
    const stream = await opendir(join(root, directory))
    const batches: SourceFile[][] = []
    for await (const entry of stream) {
      signal.throwIfAborted()
      entries += 1
      if (entries > IMPORT_LIMITS.entries || performance.now() - started > 10_000) throw new Error("INVALID_ARGS")
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (isSecretPath(path)) {
        secrets += 1
        continue
      }
      if (entry.isSymbolicLink() || !isSafeRelativePath(path) || entry.name.startsWith(".")) {
        excludedFiles += 1
        continue
      }
      if (entry.isDirectory()) {
        if (depth < IMPORT_LIMITS.depth) batches.push(await visit(path, depth + 1))
        else excludedFiles += 1
        continue
      }
      if (!entry.isFile() || !isCandidateFile(path, source)) continue
      const stat = await lstat(join(root, path)).catch(() => undefined)
      if (!stat?.isFile() || stat.nlink !== 1 || stat.size > IMPORT_LIMITS.file) {
        excludedFiles += 1
        continue
      }
      bytes += stat.size
      if (bytes > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")
      if (source === "claude-code" && /^(?:settings|claude)\.json$|^settings\/[^/]+\.json$/.test(path)) {
        const config = await getAgentImportConfigAsync(join(root, path)).catch(() => undefined)
        if (!config) {
          excludedFiles += 1
          continue
        }
        bytes += Math.max(0, config.bytes - stat.size)
        if (bytes > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")
        secrets += config.secrets
        batches.push([
          { path, content: JSON.stringify({ mcpServers: Object.fromEntries(config.names.map((name) => [name, {}])) }) },
        ])
        continue
      }
      const file = await getAgentImportFileAsync(join(root, path)).catch(() => undefined)
      if (!file) {
        excludedFiles += 1
        continue
      }
      bytes += Math.max(0, file.bytes - stat.size)
      if (bytes > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")
      if (file.kind === "secret") secrets += 1
      else if (file.kind === "excluded") excludedFiles += 1
      else batches.push([{ path, content: file.content }])
      await yieldBackground()
    }

    return batches.flat()
  }
  const files = await visit("", 0)

  return { files, bytes, excluded: { secrets, files: excludedFiles } }
}

const isCandidateFile = (path: string, source: AgentImportSourceKind): boolean => {
  if (source === "claude-code")
    return /^(?:CLAUDE\.md|projects\/[^/]+\/(?:CLAUDE\.md|memory\/[^/]+\.md)|skills\/[^/]+\/.+|(?:settings|claude)\.json|settings\/[^/]+\.json)$/i.test(
      path,
    )

  return (
    /\.md$/i.test(path) ||
    /(?:^|\/)(?:jobs|routines|cron)\.json$/i.test(path) ||
    /(?:^|\/)(?:crontab|routines\.cron)$/.test(path) ||
    /^skills\/[^/]+\/.+/.test(path)
  )
}

const getFolderAgent = (
  files: SourceFile[],
  project: string,
  index: number,
  source: AgentImportSourceKind,
): ImportAgent => {
  const relevant = files.filter(
    (file) => !file.path.startsWith("projects/") || file.path.startsWith(`projects/${project}/`),
  )
  const memories = relevant.filter((file) => /(?:^|\/)(?:memor(?:y|ies)(?:\/|\.md)|notes\/)/i.test(file.path))
  const instructions = relevant.filter(
    (file) => /\.md$/i.test(file.path) && !file.path.startsWith("skills/") && !memories.includes(file),
  )

  const skills = getSkills(relevant)
  const routines = relevant.flatMap(getFileRoutines)
  if (skills.length > 100 || memories.length > 100 || routines.length > 100) throw new Error("INVALID_ARGS")

  return {
    key: `agent-${index + 1}`,
    name: getFolderAgentName(source, project, index),
    instructions: instructions.map(({ content }) => content),
    skills,
    memories: memories.map(({ content }) => content),
    routines,
    integrations: source === "claude-code" ? getIntegrationNames(relevant) : [],
  }
}

const getSkills = (files: SourceFile[]): ImportSkill[] =>
  files.flatMap((file) => {
    const match = /^skills\/([a-z0-9][a-z0-9_-]{0,63})\/SKILL\.md$/.exec(file.path)
    const name = match?.[1]
    if (!name) return []
    const prefix = `skills/${name}/`

    return [
      {
        name,
        files: files
          .filter((item) => item.path.startsWith(prefix))
          .map((item) => ({ path: item.path.slice(prefix.length), content: item.content })),
      },
    ]
  })

const getFileRoutines = (file: SourceFile): ImportRoutine[] => {
  if (/(?:^|\/)(?:crontab|routines\.cron)$/.test(file.path))
    return file.content
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .map((line, index) => {
        const fields = line.trim().split(/\s+/)
        return getRoutine({
          name: `Rotina ${index + 1}`,
          schedule: fields.slice(0, 5).join(" "),
          prompt: fields.slice(5).join(" "),
        })
      })
  if (!/(?:^|\/)(?:jobs|routines|cron)\.json$/i.test(file.path)) return []
  const parsed: unknown = JSON.parse(file.content)
  const jobs = Array.isArray(parsed) ? parsed : getRecord(parsed, ["jobs"]).jobs
  if (!Array.isArray(jobs) || jobs.length > 100) throw new Error("INVALID_ARGS")

  return jobs.map(getRoutine)
}

const getIntegrationNames = (files: SourceFile[]): string[] =>
  Array.from(
    new Set(
      files.flatMap((file) => {
        if (!/^(?:settings|claude)\.json$|^settings\/[^/]+\.json$/.test(file.path)) return []
        try {
          const parsed: unknown = JSON.parse(file.content)
          if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) return []
          const servers = parsed.mcpServers
          if (!servers || typeof servers !== "object" || Array.isArray(servers)) return []

          return Object.keys(servers).filter((name) => /^[\p{L}\p{N} _.-]{1,80}$/u.test(name) && isSafeText(name))
        } catch {
          return []
        }
      }),
    ),
  )

const getGlobalConfig = async (
  root: string,
  usedBytes: number,
): Promise<{ names: string[]; secrets: number; files: number }> => {
  const path = join(dirname(root), ".claude.json")
  const stat = await lstat(path).catch(() => undefined)
  if (!stat) return { names: [], secrets: 0, files: 0 }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > IMPORT_LIMITS.file) return { names: [], secrets: 0, files: 1 }
  if (usedBytes + stat.size > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")
  const config = await getAgentImportConfigAsync(path).catch(() => undefined)
  if (!config) return { names: [], secrets: 0, files: 1 }
  if (usedBytes + config.bytes > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")

  return { names: config.names, secrets: config.secrets, files: 0 }
}

const getFolderAgentName = (source: AgentImportSourceKind, project: string, index: number): string => {
  const name = source === "claude-code" ? "Claude Code" : "Agente importado"
  return project ? `${name} ${index + 1}` : name
}
