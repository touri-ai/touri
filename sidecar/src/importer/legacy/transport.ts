import { Database } from "bun:sqlite"
import { rm } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type { Kernel, LegacySource } from "@touri/contracts"
import { buildChildEnv } from "../../kernel"
import { ensurePrivateDirectoryAsync, writePrivateFileAsync } from "../../kernel/async-files"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "./fs"
import { sourceOrigin } from "./identity"
import { MAX_SNAPSHOT_BYTES } from "./snapshot"

export type StagedSource = {
  dir: string
  snapshotPath: string
  source: LegacySource
  origin: string
  warnings: Array<string>
  sessionPaths: Map<string, string>
}

type StageArgs = {
  kernel: Kernel
  importId: string
  source: LegacySource
  botNames: Array<{ id: string; name: string }>
  attachmentBasenames: Array<string>
  importCodexSessions: boolean
  resumeCursors: Array<{ cursor: string; threadId: string }>
}

type SpawnedOutput = { stdout: string; stderr: string; code: number | null }

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const escapeForDoubleQuotes = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")

const doubleQuote = (value: string): string =>
  `"${escapeForDoubleQuotes(value).replace(/^((?:file:)?)\\\$HOME(?=\/|\?|$)/, "$1$$HOME")}"`

const remoteRootExpression = (root: string): string => {
  if (root === "~") return "$HOME"
  if (root.startsWith("~/")) return `$HOME/${root.slice(2)}`
  return root
}

const remotePathExpression = ({ root, path }: { root: string; path: string }): string => {
  const rootExpression = remoteRootExpression(root)
  const suffix = path.replace(/^\/+/, "")
  return `${rootExpression}/${suffix}`
}

const sourceRoot = (source: LegacySource): string => resolve(source.root.replace(/^~(?=\/|$)/, homedir()))

const isContained = ({ root, candidate }: { root: string; candidate: string }): boolean => {
  const suffix = relative(root, candidate)
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !suffix.startsWith(sep))
}

const validatedLocalAbsoluteFile = ({ root, candidate }: { root: string; candidate: string }): string | null => {
  const rootPath = resolve(root)
  const candidatePath = resolve(candidate)
  try {
    const rootStat = lstatSync(rootPath)
    const candidateStat = lstatSync(candidatePath)
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      candidateStat.isSymbolicLink()
    )
      return null
    const realRoot = realpathSync(rootPath)
    const realCandidate = realpathSync(candidatePath)
    return isContained({ root: realRoot, candidate: realCandidate }) ? candidatePath : null
  } catch {
    return null
  }
}

const validatedLocalFile = ({ root, relativePath }: { root: string; relativePath: string }): string | null =>
  validatedLocalAbsoluteFile({ root, candidate: join(root, relativePath) })

const localRelativePath = ({ root, file }: { root: string; file: string }): string => {
  const rootPath = resolve(root)
  const filePath = resolve(file)
  const result = relative(rootPath, filePath)
  if (result === "" || result.startsWith(`..${sep}`) || result === ".." || result.startsWith(sep))
    throw new Error(`Source path is outside the legacy app root: ${file}`)
  return result.split(sep).join("/")
}

const isCredentialLike = (relativePath: string): boolean => {
  const lowered = relativePath.toLowerCase()
  const parts = lowered.split("/")
  return parts.some(
    (part) =>
      part === "config.json" ||
      part === "sessions.json" ||
      part === "hook-tokens" ||
      part === "browser-engine-key" ||
      part === "webhooks.json" ||
      part === "events" ||
      part === "native" ||
      part === "tool-results" ||
      part === "checkpoints" ||
      part === "memory-journal" ||
      part.includes("token") ||
      part.includes("credential") ||
      part.includes("auth"),
  )
}

const isAllowedWorkspaceFile = ({ relativePath, bytes }: { relativePath: string; bytes: number }): boolean => {
  if (isCredentialLike(relativePath) || bytes >= 1024 * 1024) return false
  const parts = relativePath.split("/")
  if (parts.length === 2 && parts[1] === "MEMORY.md") return true
  if (parts.length < 3 || !["memory", "skills"].includes(parts[1] ?? "")) return false
  return parts.at(-1)?.toLowerCase().endsWith(".md") ?? false
}

const walkLocalWorkspace = ({ root, botKey }: { root: string; botKey: string }): Array<string> => {
  const workspaceRoot = join(root, "workspaces", botKey)
  try {
    if (!lstatSync(workspaceRoot).isDirectory() || lstatSync(workspaceRoot).isSymbolicLink()) return []
    if (!isContained({ root: realpathSync(root), candidate: realpathSync(workspaceRoot) })) return []
  } catch {
    return []
  }
  const result: Array<string> = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = localRelativePath({ root, file: path })
      const workspaceRelative = relativePath.split("/").slice(1).join("/")
      const bytes = lstatSync(path).size
      if (isAllowedWorkspaceFile({ relativePath: workspaceRelative, bytes })) result.push(relativePath)
    }
  }
  visit(workspaceRoot)
  return result.sort()
}

const commandArgs = ({
  source,
  command,
}: {
  source: Extract<LegacySource, { kind: "ssh" }>
  command: string
}): Array<string> => {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
  if (source.port !== undefined) args.push("-p", String(source.port))
  args.push(`${source.user}@${source.host}`, command)
  return args
}

const runSpawn = async ({
  kernel,
  cmd,
  args,
  maxBytes = 8 * 1024 * 1024,
}: {
  kernel: Kernel
  cmd: string
  args: Array<string>
  maxBytes?: number
}): Promise<SpawnedOutput> => {
  const environment = buildChildEnv({ base: await kernel.shellEnv() })
  const spawned = kernel.spawnTree({ cmd, args, cwd: kernel.paths.appData, env: environment })
  if (!spawned.success) throw new Error(`${cmd} failed to start: ${spawned.error}`)
  const bounded = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<string> => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > limit) throw new Error("Source transfer exceeds import limit")
        chunks.push(chunk.value)
      }
      return Buffer.concat(chunks).toString("utf8")
    } catch (error) {
      spawned.kill("SIGKILL")
      void reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader.releaseLock()
    }
  }
  const timer = setTimeout(() => spawned.kill("SIGKILL"), 60_000)
  try {
    const [stdout, stderr, exited] = await Promise.all([
      bounded(spawned.stdout, maxBytes),
      bounded(spawned.stderr, 16_384),
      spawned.exited,
    ])
    return { stdout, stderr, code: exited.code }
  } finally {
    clearTimeout(timer)
  }
}

const copyLocal = async ({
  kernel,
  root,
  relativePath,
  destination,
}: {
  kernel: Kernel
  root: string
  relativePath: string
  destination: string
}): Promise<boolean> => {
  const sourcePath = validatedLocalFile({ root, relativePath })
  if (!sourcePath) return false
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dirname(destination) })
  await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: readFileSync(sourcePath) })
  return true
}

const copyRemote = async ({
  kernel,
  source,
  relativePath,
  destination,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  relativePath: string
  destination: string
}): Promise<boolean> => {
  const remotePath = remotePathExpression({ root: source.root, path: relativePath })
  const result = await runSpawn({
    kernel,
    cmd: "ssh",
    args: commandArgs({ source, command: `cat -- ${doubleQuote(remotePath)}` }),
  })
  if (result.code !== 0) return false
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dirname(destination) })
  await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: result.stdout })
  return true
}

const copyRemoteAbsolute = async ({
  kernel,
  source,
  remotePath,
  destination,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  remotePath: string
  destination: string
}): Promise<boolean> => {
  const result = await runSpawn({
    kernel,
    cmd: "ssh",
    args: commandArgs({ source, command: `cat -- ${doubleQuote(remotePath)}` }),
  })
  if (result.code !== 0) return false
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dirname(destination) })
  await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: result.stdout })
  return true
}

const dumpLocal = async ({
  kernel,
  root,
  destination,
}: {
  kernel: Kernel
  root: string
  destination: string
}): Promise<void> => {
  const sourceDb = validatedLocalFile({ root, relativePath: "messages.db" })
  if (!sourceDb) throw new Error("Source messages.db must be a regular file inside the source root")
  if (lstatSync(sourceDb).size > MAX_SNAPSHOT_BYTES) throw new Error("Source snapshot exceeds import limit")
  const database = new Database(sourceDb, { readonly: true })
  try {
    const bytes = database.serialize()
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error("Source snapshot exceeds import limit")
    await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: rollbackSnapshot(bytes) })
  } finally {
    database.close()
  }
}

const SQLITE_HEADER = "SQLite format 3\u0000"

const rollbackSnapshot = (bytes: Buffer): Buffer => {
  // A serialized snapshot contains the committed pages, but can retain WAL mode.
  // SQLite documents this conversion for in-memory deserialization:
  // https://www.sqlite.org/c3ref/deserialize.html
  bytes[18] = 1
  bytes[19] = 1
  return bytes
}

const PYTHON_SERIALIZE = [
  "import base64, sqlite3, sys",
  "source = sqlite3.connect(sys.argv[1], uri=True)",
  "memory = sqlite3.connect(':memory:')",
  "source.backup(memory)",
  "source.close()",
  "sys.stdout.write(base64.b64encode(memory.serialize()).decode('ascii'))",
].join("\n")

const snapshotViaPython = async ({
  kernel,
  source,
  uri,
  destination,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  uri: string
  destination: string
}): Promise<{ success: true } | { success: false; error: string }> => {
  const command = `python3 -c ${shellQuote(PYTHON_SERIALIZE)} ${doubleQuote(uri)}`
  const result = await runSpawn({
    kernel,
    cmd: "ssh",
    args: commandArgs({ source, command }),
    maxBytes: Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4 + 2,
  })
  if (result.code !== 0) return { success: false, error: "Remote Python SQLite snapshot unavailable" }
  const encoded = result.stdout.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { success: false, error: "Invalid snapshot encoding" }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length > MAX_SNAPSHOT_BYTES || bytes.toString("base64") !== encoded)
    return { success: false, error: "Invalid or oversized SQLite snapshot" }
  if (bytes.subarray(0, SQLITE_HEADER.length).toString("latin1") !== SQLITE_HEADER)
    return { success: false, error: "python snapshot did not return a SQLite database" }
  await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: rollbackSnapshot(bytes) })
  return { success: true }
}

const dumpRemote = async ({
  kernel,
  source,
  destination,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  destination: string
}): Promise<void> => {
  const uri = `file:${remotePathExpression({ root: source.root, path: "messages.db" })}?mode=ro`
  const viaPython = await snapshotViaPython({ kernel, source, uri, destination })
  if (viaPython.success) return
  await rm(destination, { force: true })
  throw new Error(
    `Unable to snapshot remote messages.db: ${viaPython.error}. Python with SQLite serialize support is required.`,
  )
}

const findRemoteFiles = async ({
  kernel,
  source,
  botKey,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  botKey: string
}): Promise<Array<string>> => {
  const workspace = remotePathExpression({ root: source.root, path: `workspaces/${botKey}` })
  const command = [
    "find",
    doubleQuote(workspace),
    "-type f",
    "\\(",
    "-name 'MEMORY.md' -o -path '*/memory/*' -o -path '*/skills/*'",
    "\\)",
    "-size -1M",
    "-print",
  ].join(" ")
  const result = await runSpawn({ kernel, cmd: "ssh", args: commandArgs({ source, command }) })
  if (result.code !== 0) return []
  return result.stdout
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0 && !isCredentialLike(path))
    .flatMap((path) => {
      const marker = `workspaces/${botKey}/`
      const markerIndex = path.indexOf(marker)
      const relativePath = markerIndex >= 0 ? path.slice(markerIndex + marker.length) : ""
      return relativePath.length > 0 && isAllowedWorkspaceFile({ relativePath: `x/${relativePath}`, bytes: 1 })
        ? [`${marker}${relativePath}`]
        : []
    })
    .map((path) =>
      path
        .split("/")
        .map((part) => part.trim())
        .join("/"),
    )
}

type LocalRollout = { path: string; root: string }

const findLocalRollout = ({ root, cursor }: { root: string; cursor: string }): LocalRollout | null => {
  const cursorName = basename(cursor)
  const filename = cursorName.endsWith(".jsonl") ? cursorName : `${cursorName}.jsonl`
  if (!/^rollout-[A-Za-z0-9._-]+\.jsonl$/.test(filename)) return null
  const roots = [
    join(root, "codex-sessions"),
    join(root, ".codex", "sessions"),
    join(dirname(root), ".codex", "sessions"),
  ]
  for (const allowedRoot of roots) {
    const candidate = validatedLocalAbsoluteFile({ root: allowedRoot, candidate: join(allowedRoot, filename) })
    if (candidate) return { path: candidate, root: allowedRoot }
  }
  const visit = (directory: string, allowedRoot: string): LocalRollout | null => {
    try {
      const directoryStat = lstatSync(directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    } catch {
      return null
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = visit(path, allowedRoot)
        if (found) return found
      } else if (entry.isFile() && entry.name === filename) {
        const candidate = validatedLocalAbsoluteFile({ root: allowedRoot, candidate: path })
        if (candidate) return { path: candidate, root: allowedRoot }
      }
    }
    return null
  }
  for (const allowedRoot of roots.slice(0, 2)) {
    const found = visit(allowedRoot, allowedRoot)
    if (found) return found
  }
  return null
}

const findRemoteRollout = async ({
  kernel,
  source,
  cursor,
}: {
  kernel: Kernel
  source: Extract<LegacySource, { kind: "ssh" }>
  cursor: string
}): Promise<string | null> => {
  const cursorName = basename(cursor)
  const filename = cursorName.endsWith(".jsonl") ? cursorName : `${cursorName}.jsonl`
  if (!/^rollout-[A-Za-z0-9._-]+\.jsonl$/.test(filename)) return null
  const sessionRoot = source.root.startsWith("~/") ? "$HOME/.codex/sessions" : "$HOME/.codex/sessions"
  const command = `find ${doubleQuote(sessionRoot)} -type f -name ${shellQuote(filename)} -print -quit`
  const result = await runSpawn({ kernel, cmd: "ssh", args: commandArgs({ source, command }) })
  if (result.code !== 0) return null
  const path = result.stdout.trim()
  return path.length > 0 ? path : null
}

const copyLocalAbsolute = async ({
  kernel,
  sourcePath,
  allowedRoot,
  destination,
}: {
  kernel: Kernel
  sourcePath: string
  allowedRoot: string
  destination: string
}): Promise<boolean> => {
  const validatedPath = validatedLocalAbsoluteFile({ root: allowedRoot, candidate: sourcePath })
  if (!validatedPath) return false
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dirname(destination) })
  await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: readFileSync(validatedPath) })
  return true
}

export const stageLegacySource = async (args: StageArgs): Promise<StagedSource> => {
  const { kernel, importId, source, botNames, attachmentBasenames, importCodexSessions, resumeCursors } = args
  const dir = join(kernel.paths.importsDir, "legacy", importId)
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dir })
  const warnings: Array<string> = []
  const snapshotPath = join(dir, "messages.db")
  const root = source.kind === "local" ? sourceRoot(source) : null

  if (source.kind === "local") {
    if (!existsSync(snapshotPath)) await dumpLocal({ kernel, root: root ?? "", destination: snapshotPath })
    for (const relativePath of ["bots.json", "routines.json"]) {
      if (!(await copyLocal({ kernel, root: root ?? "", relativePath, destination: join(dir, relativePath) })))
        throw new Error(`Missing required source file ${relativePath}`)
    }
  } else {
    if (!existsSync(snapshotPath)) await dumpRemote({ kernel, source, destination: snapshotPath })
    for (const relativePath of ["bots.json", "routines.json"]) {
      const destination = join(dir, relativePath)
      await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: dirname(destination) })
      const copied = await copyRemote({ kernel, source, relativePath, destination })
      if (!copied) throw new Error(`Missing required source file ${relativePath}`)
    }
  }

  const copyBasic = async (relativePath: string, destinationRelativePath = relativePath): Promise<boolean> => {
    const destination = join(dir, destinationRelativePath)
    const copied =
      source.kind === "local"
        ? await copyLocal({ kernel, root: root ?? "", relativePath, destination })
        : await copyRemote({ kernel, source, relativePath, destination })
    return copied
  }

  for (const bot of botNames) {
    const soulDestination = `bots/${bot.id}/SOUL.md`
    const copiedSoul =
      (await copyBasic(soulDestination)) ||
      (bot.name !== bot.id && (await copyBasic(`bots/${bot.name}/SOUL.md`, soulDestination)))
    if (!copiedSoul) warnings.push(`Allowlisted source file not found: ${soulDestination}`)
    const workspaceFiles =
      source.kind === "local"
        ? [bot.name, bot.id]
            .filter((key, index, keys) => keys.indexOf(key) === index)
            .flatMap((botKey) => walkLocalWorkspace({ root: root ?? "", botKey }))
        : (await findRemoteFiles({ kernel, source, botKey: bot.id })).concat(
            bot.name === bot.id ? [] : await findRemoteFiles({ kernel, source, botKey: bot.name }),
          )
    for (const relativePath of workspaceFiles) {
      const destinationRelativePath = relativePath
        .replace(`workspaces/${bot.name}/`, `workspaces/${bot.id}/`)
        .replace(`workspaces/${bot.id}/`, `workspaces/${bot.id}/`)
      await copyBasic(relativePath, destinationRelativePath)
    }
  }

  for (const filename of new Set(attachmentBasenames)) {
    if (!(await copyBasic(`attachments/${filename}`)))
      warnings.push(`Allowlisted source file not found: attachments/${filename}`)
  }

  const sessionPaths = new Map<string, string>()
  if (importCodexSessions) {
    for (const { cursor, threadId } of resumeCursors) {
      const localRollout = source.kind === "local" ? findLocalRollout({ root: root ?? "", cursor }) : null
      const sourcePath =
        source.kind === "local" ? (localRollout?.path ?? null) : await findRemoteRollout({ kernel, source, cursor })
      if (!sourcePath) {
        warnings.push(`Codex rollout not found for ${threadId}`)
        continue
      }
      const filename = basename(sourcePath)
      const targetRelative = `codex-sessions/${threadId}/${filename}`
      const destination = join(dir, targetRelative)
      const copied =
        source.kind === "local"
          ? await copyLocalAbsolute({ kernel, sourcePath, allowedRoot: localRollout?.root ?? root ?? "", destination })
          : await copyRemoteAbsolute({ kernel, source, remotePath: sourcePath, destination })
      if (copied) sessionPaths.set(threadId, destination)
      else warnings.push(`Unable to copy Codex rollout for ${threadId}`)
    }
  } else if (resumeCursors.length > 0) {
    warnings.push("Codex session copying is disabled; imported chats will use a handoff summary")
  }

  return {
    dir,
    snapshotPath,
    source,
    origin: sourceOrigin(source),
    warnings,
    sessionPaths,
  }
}

export const readStagedJson = ({ dir, relativePath }: { dir: string; relativePath: string }): unknown =>
  JSON.parse(readFileSync(join(dir, relativePath), "utf8")) as unknown

export const buildAllowlistedCopyCommandList = ({
  source,
  botNames,
  attachmentBasenames,
  sessionFilenames,
}: {
  source: LegacySource
  botNames: Array<{ id: string; name: string }>
  attachmentBasenames: Array<string>
  sessionFilenames: Array<string>
}): Array<string> => {
  const paths = [
    "bots.json",
    "routines.json",
    ...botNames.flatMap(({ id, name }) => [
      `bots/${id}/SOUL.md`,
      ...(name === id ? [] : [`bots/${name}/SOUL.md`]),
      `workspaces/${name}/MEMORY.md`,
    ]),
    ...attachmentBasenames.map((filename) => `attachments/${filename}`),
  ]
  if (source.kind === "local")
    return paths
      .map((path) => `copy ${join(sourceRoot(source), path)}`)
      .concat(sessionFilenames.map((path) => `copy ${path}`))
  return paths
    .map(
      (path) =>
        `ssh ${source.user}@${source.host} cat -- ${doubleQuote(remotePathExpression({ root: source.root, path }))}`,
    )
    .concat(sessionFilenames.map((path) => `ssh ${source.user}@${source.host} cat -- ${doubleQuote(path)}`))
}
