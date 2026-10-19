import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Kernel, Project } from "@touri/contracts"
import { withDeadline } from "../kernel/policy"
import type { CommandOutput, ProjectResult } from "./types"

const cleanRemote = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed)
      url.username = ""
      url.password = ""
      return url.toString().replace(/\/$/, "")
    } catch {
      return trimmed.replace(/\/\/[^/@]+@/, "//")
    }
  }
  return trimmed
}

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text()

export const runCommand = async ({
  kernel,
  cmd,
  args,
  cwd,
  env,
  signal,
  timeoutMs = 20_000,
}: {
  kernel: Kernel
  cmd: string
  args: Array<string>
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ProjectResult<{ output: CommandOutput }>> => {
  const baseEnv = await kernel.shellEnv()
  if (signal?.aborted) return { success: false, errorCode: "GIT_FAILED", error: "Operação Git cancelada." }
  const child = kernel.spawnTree({
    cmd,
    args,
    cwd,
    env: {
      ...baseEnv,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
      ...env,
    },
  })
  if (!child.success) return { success: false, errorCode: "GIT_FAILED", error: child.error }
  const cancel = () => child.kill("SIGKILL")
  signal?.addEventListener("abort", cancel, { once: true })
  const stdout = readStream(child.stdout)
  const stderr = readStream(child.stderr)
  try {
    const [stdoutText, stderrText, exit] = await withDeadline({
      operation: () => Promise.all([stdout, stderr, child.exited]),
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
    return { success: true, output: { ...exit, stdout: stdoutText, stderr: stderrText } }
  } catch {
    cancel()
    return {
      success: false,
      errorCode: "GIT_FAILED",
      error: "O Git não respondeu no prazo. Confira o repositório e tente novamente.",
    }
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

const gitValue = async ({
  kernel,
  projectPath,
  args,
  signal,
  env,
}: {
  kernel: Kernel
  projectPath: string
  args: Array<string>
  signal?: AbortSignal
  env?: Record<string, string>
}): Promise<string | null> => {
  const result = await runCommand({
    kernel,
    cmd: "git",
    args,
    cwd: projectPath,
    ...(signal ? { signal } : {}),
    ...(env ? { env } : {}),
  })
  if (!result.success || result.output.code !== 0) return null
  return result.output.stdout.trim() || null
}

/** Registration needs refs/config only, never a worktree scan or repository helpers. Call after consent. */
export const inspectGitMetadata = async ({
  kernel,
  projectPath,
  signal,
}: {
  kernel: Kernel
  projectPath: string
  signal?: AbortSignal
}): Promise<{ remote: string | null; defaultBranch: string | null } | null> => {
  const value = (args: string[]) =>
    gitValue({
      kernel,
      projectPath,
      args: [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.askPass=",
        "-c",
        "credential.helper=",
        ...args,
      ],
      env: { GIT_CONFIG_NOSYSTEM: "1" },
      ...(signal ? { signal } : {}),
    })
  if ((await value(["rev-parse", "--show-toplevel"])) === null) return null
  const [remote, upstream, branch] = await Promise.all([
    value(["remote", "get-url", "origin"]),
    value(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    value(["symbolic-ref", "--short", "HEAD"]),
  ])
  return {
    remote: remote === null ? null : cleanRemote(remote),
    defaultBranch: upstream?.replace(/^origin\//, "") ?? branch,
  }
}

export const inspectGit = async ({
  kernel,
  projectPath,
  signal,
}: {
  kernel: Kernel
  projectPath: string
  signal?: AbortSignal
}): Promise<{
  branch: string | null
  remote: string | null
  defaultBranch: string | null
  dirty: boolean
  ahead: number
  behind: number
  commit: string | null
} | null> => {
  const value = (args: string[]) => gitValue({ kernel, projectPath, args, ...(signal ? { signal } : {}) })
  const root = await value(["rev-parse", "--show-toplevel"])
  if (root === null) return null
  const [branch, remoteValue, upstream, status, counts, commit] = await Promise.all([
    value(["branch", "--show-current"]),
    value(["remote", "get-url", "origin"]),
    value(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    value(["status", "--porcelain"]),
    value(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    value(["rev-parse", "--verify", "HEAD"]),
  ])
  const remote = remoteValue === null ? null : cleanRemote(remoteValue)
  const defaultBranch = upstream?.replace(/^origin\//, "") ?? branch
  const [aheadText = "0", behindText = "0"] = counts?.split(/\s+/) ?? []
  return {
    branch,
    remote,
    defaultBranch,
    dirty: status !== null && status.length > 0,
    ahead: Number.isFinite(Number(aheadText)) ? Number(aheadText) : 0,
    behind: Number.isFinite(Number(behindText)) ? Number(behindText) : 0,
    commit,
  }
}

export const gitStatus = async ({
  kernel,
  project,
}: {
  kernel: Kernel
  project: Project
}): Promise<
  ProjectResult<{
    branch: string | null
    dirty: boolean
    ahead: number
    behind: number
    commit: string | null
    remote: string | null
  }>
> => {
  const info = await inspectGit({ kernel, projectPath: project.path })
  if (info === null)
    return { success: true, branch: null, dirty: false, ahead: 0, behind: 0, commit: null, remote: null }
  return {
    success: true,
    branch: info.branch,
    dirty: info.dirty,
    ahead: info.ahead,
    behind: info.behind,
    commit: info.commit,
    remote: info.remote,
  }
}

export const projectHints = ({
  project,
}: {
  project: Project
}): Array<{ kind: "node" | "packageManager" | "service" | "envExample"; value: string; source: string }> => {
  const hints: Array<{ kind: "node" | "packageManager" | "service" | "envExample"; value: string; source: string }> = []
  const packageJsonPath = join(project.path, "package.json")
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        engines?: { node?: unknown }
        packageManager?: unknown
      }
      if (typeof packageJson.engines?.node === "string")
        hints.push({ kind: "node", value: packageJson.engines.node, source: "package.json" })
      if (typeof packageJson.packageManager === "string")
        hints.push({ kind: "packageManager", value: packageJson.packageManager, source: "package.json" })
    } catch {
      // A malformed package manifest is a project issue, not a reason to fail project_info.
    }
  }
  for (const filename of [".nvmrc", ".node-version"]) {
    const path = join(project.path, filename)
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8").trim()
      if (value.length > 0) hints.push({ kind: "node", value, source: filename })
    }
  }
  if (existsSync(join(project.path, "pnpm-workspace.yaml")))
    hints.push({ kind: "packageManager", value: "pnpm workspace", source: "pnpm-workspace.yaml" })
  const envExample = join(project.path, ".env.example")
  if (existsSync(envExample)) {
    const content = readFileSync(envExample, "utf8")
    for (const service of ["MONGO", "REDIS"]) {
      if (new RegExp(`(^|\\n)[^\\n]*${service}[^\\n]*`, "i").test(content)) {
        hints.push({ kind: "service", value: service === "MONGO" ? "MongoDB" : "Redis", source: ".env.example" })
        hints.push({ kind: "envExample", value: service, source: ".env.example" })
      }
    }
  }
  for (const filename of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (existsSync(join(project.path, filename)))
      hints.push({ kind: "service", value: `compose file: ${filename}`, source: filename })
  }
  return hints
}

export const cloneProject = async ({
  kernel,
  url,
  destination,
  signal,
}: {
  kernel: Kernel
  url: string
  destination: string
  signal?: AbortSignal
}): Promise<ProjectResult<Record<never, never>>> => {
  // git honors the process umask; pre-creating the folder keeps a private
  // repository unreadable by other macOS accounts even under a shared parent.
  try {
    await mkdir(destination, { mode: 0o700 })
  } catch {
    return { success: false, errorCode: "GIT_FAILED", error: "Não foi possível criar a pasta de destino." }
  }
  const result = await runCommand({
    kernel,
    cmd: "git",
    args: ["clone", "--no-hardlinks", "--", url, destination],
    cwd: dirname(destination),
    ...(signal ? { signal } : {}),
  })
  if (!result.success) {
    await rm(destination, { recursive: true, force: true })
    return result
  }
  if (result.output.code !== 0) {
    await rm(destination, { recursive: true, force: true })
    return {
      success: false,
      errorCode: "GIT_FAILED",
      error: kernel.redact(result.output.stderr || result.output.stdout).slice(0, 2000),
    }
  }
  return { success: true }
}

export const cloneSource = (input: string): string | null => {
  const source = input.trim()
  if (!source || source.startsWith("-")) return null
  if (source.startsWith("/")) return source
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source)
    } catch {
      return null
    }
  }
  if (/^ssh:\/\//.test(source) || /^https?:\/\//.test(source)) {
    try {
      const url = new URL(source)
      return url.hostname && url.pathname !== "/" ? source : null
    } catch {
      return null
    }
  }
  return /^[\w.-]+@[\w.-]+:[^\s]+$/.test(source) ? source : null
}

export const cloneName = ({ url }: { url: string }): string => {
  const normalized = url.replace(/\/$/, "")
  const value = basename(normalized).replace(/\.git$/i, "")
  return value.length > 0 ? value : "project"
}
