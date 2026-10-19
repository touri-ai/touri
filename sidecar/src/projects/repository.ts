import type { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  EnvValue,
  Kernel,
  ListeningPort,
  ProcessRunState,
  ProcessSpec,
  Project,
  SecretMeta,
} from "@touri/contracts"
import { createStandingGrantStore } from "../approvals/grants"
import { withSecretMutation } from "../approvals/secrets"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import type { ProjectResult, ProjectStore } from "./types"

type Row = Record<string, unknown>

const asRow = (value: unknown): Row | null => (typeof value === "object" && value !== null ? (value as Row) : null)

const stringValue = (row: Row, key: string, fallback = ""): string => {
  const value = row[key]
  return typeof value === "string" ? value : fallback
}

const nullableString = (row: Row, key: string): string | null => {
  const value = row[key]
  return typeof value === "string" ? value : null
}

const numberValue = (row: Row, key: string, fallback = 0): number => {
  const value = row[key]
  return typeof value === "number" ? value : fallback
}

const booleanValue = (row: Row, key: string): boolean => numberValue(row, key) === 1

const jsonValue = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const projectFromRow = (row: Row): Project => ({
  id: stringValue(row, "id"),
  name: stringValue(row, "name"),
  path: stringValue(row, "path"),
  gitRemote: nullableString(row, "git_remote"),
  defaultBranch: nullableString(row, "default_branch"),
  dataDir: stringValue(row, "data_dir"),
  createdAt: numberValue(row, "created_at"),
  updatedAt: numberValue(row, "updated_at"),
  archivedAt: row.archived_at === null ? null : numberValue(row, "archived_at"),
})

const secretUsage = (value: unknown): SecretMeta["usage"] => {
  const parsed = jsonValue<unknown>(value, null)
  const usage = asRow(parsed)
  return { env: usage?.env === true, browser: usage?.browser === true }
}

const secretFromRow = (row: Row): SecretMeta => ({
  id: stringValue(row, "id"),
  projectId: row.project_id === null ? null : nullableString(row, "project_id"),
  name: stringValue(row, "name"),
  usage: secretUsage(row.usage_json),
  browserOrigin: nullableString(row, "browser_origin"),
  createdAt: numberValue(row, "created_at"),
  updatedAt: numberValue(row, "updated_at"),
})

const processFromRow = (row: Row): ProcessSpec => ({
  vmBotId: nullableString(row, "vm_bot_id"),
  id: stringValue(row, "id"),
  projectId: stringValue(row, "project_id"),
  name: nullableString(row, "vm_bot_id")
    ? stringValue(row, "name").split(":").slice(1).join(":")
    : stringValue(row, "name"),
  command: stringValue(row, "command"),
  cwd: stringValue(row, "cwd"),
  env: jsonValue<Record<string, EnvValue>>(row.env_json, {}),
  autostart: booleanValue(row, "autostart"),
  restart: row.restart === "never" || row.restart === "always" ? row.restart : "on-failure",
  dependsOn: jsonValue<Array<string>>(row.depends_on_json, []),
  ready: row.ready_json === null ? null : jsonValue<ProcessSpec["ready"] | null>(row.ready_json, null),
  previewPort: row.preview_port === null ? null : numberValue(row, "preview_port"),
  createdBy: row.created_by === "user" ? "user" : "agent",
  createdAt: numberValue(row, "created_at"),
  updatedAt: numberValue(row, "updated_at"),
})

const portsFromRow = (row: Row): Array<ListeningPort> => jsonValue<Array<ListeningPort>>(row.ports_json, [])

const processRunFromRow = (row: Row): ProcessRunState => ({
  id: stringValue(row, "id"),
  processId: stringValue(row, "process_id"),
  pid: row.pid === null ? null : numberValue(row, "pid"),
  pgid: row.pgid === null ? null : numberValue(row, "pgid"),
  status:
    row.status === "starting" ||
    row.status === "running" ||
    row.status === "ready" ||
    row.status === "exited" ||
    row.status === "crashed"
      ? row.status
      : "stopped",
  exitCode: row.exit_code === null ? null : numberValue(row, "exit_code"),
  signal: nullableString(row, "signal"),
  ports: portsFromRow(row),
  logPath: stringValue(row, "log_path"),
  startedAt: numberValue(row, "started_at"),
  endedAt: row.ended_at === null ? null : numberValue(row, "ended_at"),
})

const resultError = <C extends ProjectResult<never>["errorCode"]>(
  errorCode: C,
  error: string,
): ProjectResult<never> => ({
  success: false,
  errorCode,
  error,
})

const ensureProjectDataDir = async (dataDir: string): Promise<void> => {
  await ensurePrivateDirectoryAsync({ root: dataDir })
  for (const name of ["mongo", "redis", "logs", "tmp"])
    await ensurePrivateDirectoryAsync({ root: dataDir, path: join(dataDir, name) })
}

export const createProjectStore = ({ kernel }: { kernel: Kernel }): ProjectStore => {
  const database = kernel.db as Database

  const listProjects = (): Array<Project> =>
    (
      database
        .query("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE")
        .all() as Array<unknown>
    )
      .map(asRow)
      .filter((row): row is Row => row !== null)
      .map(projectFromRow)

  const getProject = (projectId: string): Project | null => {
    const row = asRow(database.query("SELECT * FROM projects WHERE id = ?").get(projectId))
    return row === null ? null : projectFromRow(row)
  }

  const getProjectByPath = (path: string): Project | null => {
    const row = asRow(database.query("SELECT * FROM projects WHERE path = ? AND archived_at IS NULL").get(path))
    return row === null ? null : projectFromRow(row)
  }

  const createProject = async ({
    id,
    name,
    path,
    gitRemote,
    defaultBranch,
    dataDir,
    now,
  }: Parameters<ProjectStore["createProject"]>[0]): Promise<ProjectResult<{ project: Project }>> => {
    if (getProjectByPath(path) !== null) return resultError("PROJECT_EXISTS", `Project already connected: ${path}`)
    try {
      await ensureProjectDataDir(dataDir)
      database
        .query(
          "INSERT INTO projects (id, name, path, git_remote, default_branch, data_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, name, path, gitRemote, defaultBranch, dataDir, now, now)
      const project = getProject(id)
      if (project) kernel.publish({ type: "project.created", project })
      return project === null
        ? resultError("NOT_FOUND", "Project was inserted but could not be read")
        : { success: true, project }
    } catch (error) {
      return resultError("PROJECT_EXISTS", error instanceof Error ? error.message : String(error))
    }
  }

  const listSecrets = ({ projectId }: { projectId: string | null }): Array<SecretMeta> => {
    const query =
      projectId === null
        ? "SELECT * FROM secrets WHERE project_id IS NULL ORDER BY name"
        : "SELECT * FROM secrets WHERE project_id = ? ORDER BY name"
    const rows = (
      projectId === null ? database.query(query).all() : database.query(query).all(projectId)
    ) as Array<unknown>
    return rows
      .map(asRow)
      .filter((row): row is Row => row !== null)
      .map(secretFromRow)
  }

  const getSecret = ({ projectId, name }: { projectId: string | null; name: string }): SecretMeta | null => {
    const query =
      projectId === null
        ? "SELECT * FROM secrets WHERE project_id IS NULL AND name = ?"
        : "SELECT * FROM secrets WHERE project_id = ? AND name = ?"
    const value = projectId === null ? database.query(query).get(name) : database.query(query).get(projectId, name)
    const row = asRow(value)
    return row === null ? null : secretFromRow(row)
  }

  const upsertSecret = ({
    projectId,
    name,
    usage,
    browserOrigin,
    now,
  }: Parameters<ProjectStore["upsertSecret"]>[0]): ProjectResult<{ secret: SecretMeta }> => {
    const existing = getSecret({ projectId, name })
    const id = existing?.id ?? kernel.newId()
    const account = `${projectId ?? "global"}/${name}`
    try {
      if (existing === null) {
        database
          .query(
            "INSERT INTO secrets (id, project_id, name, keychain_account, usage_json, browser_origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(id, projectId, name, account, JSON.stringify(usage), browserOrigin, now, now)
      } else {
        database
          .query("UPDATE secrets SET usage_json = ?, browser_origin = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(usage), browserOrigin, Math.max(now, existing.updatedAt + 1), id)
      }
      const secret = getSecret({ projectId, name })
      return secret === null ? resultError("NOT_FOUND", "Secret metadata could not be read") : { success: true, secret }
    } catch (error) {
      return resultError("INVALID_ARGS", error instanceof Error ? error.message : String(error))
    }
  }

  const deleteSecret = async ({
    projectId,
    name,
  }: {
    projectId: string | null
    name: string
  }): Promise<ProjectResult<Record<never, never>>> => {
    return withSecretMutation(kernel, `${projectId ?? "global"}/${name}`, async () => {
      const secret = getSecret({ projectId, name })
      if (!secret) return resultError("SECRET_NOT_FOUND", "Credencial não encontrada.")
      try {
        const revision = Math.max(Date.now(), secret.updatedAt + 1)
        database.query("UPDATE secrets SET updated_at = ? WHERE id = ?").run(revision, secret.id)
        createStandingGrantStore(kernel).revokeSecret(secret.id)
        const row = database.query("SELECT keychain_account FROM secrets WHERE id = ?").get(secret.id) as {
          keychain_account: string
        }
        const deleted = await kernel.callHost("keychain.delete", { account: row.keychain_account })
        if (!deleted.success)
          return resultError(deleted.errorCode, "Não foi possível excluir a credencial do cofre. Tente novamente.")
        const current = getSecret({ projectId, name })
        if (current?.id !== secret.id || current.updatedAt !== revision)
          return resultError("DENIED", "A credencial mudou durante a exclusão. Tente novamente.")
        const query =
          projectId === null
            ? "DELETE FROM secrets WHERE project_id IS NULL AND name = ?"
            : "DELETE FROM secrets WHERE project_id = ? AND name = ?"
        const result = projectId === null ? database.query(query).run(name) : database.query(query).run(projectId, name)
        if (result.changes === 0) return resultError("SECRET_NOT_FOUND", `Secret ${name} is not configured`)
        return { success: true }
      } catch (error) {
        return resultError("INVALID_ARGS", kernel.redact(error instanceof Error ? error.message : String(error)))
      }
    })
  }

  const listProcessSpecs = ({ projectId }: { projectId: string }): Array<ProcessSpec> =>
    (database.query("SELECT * FROM processes WHERE project_id = ? ORDER BY name").all(projectId) as Array<unknown>)
      .map(asRow)
      .filter((row): row is Row => row !== null)
      .map(processFromRow)

  const getProcessSpec = ({ processId }: { processId: string }): ProcessSpec | null => {
    const row = asRow(database.query("SELECT * FROM processes WHERE id = ?").get(processId))
    return row === null ? null : processFromRow(row)
  }

  const getProcessSpecByName = ({
    projectId,
    name,
    vmBotId,
  }: {
    projectId: string
    name: string
    vmBotId?: string | null
  }): ProcessSpec | null => {
    const row = asRow(
      database
        .query("SELECT * FROM processes WHERE project_id = ? AND name = ?")
        .get(projectId, vmBotId ? `${vmBotId}:${name}` : name),
    )
    return row === null ? null : processFromRow(row)
  }

  const upsertProcess = (args: Parameters<ProjectStore["upsertProcess"]>[0]): ProjectResult<{ spec: ProcessSpec }> => {
    const existing = getProcessSpecByName({ projectId: args.projectId, name: args.name, vmBotId: args.vmBotId ?? null })
    const id = existing?.id ?? kernel.newId()
    try {
      if (existing === null) {
        database
          .query(
            "INSERT INTO processes (id, project_id, name, command, cwd, env_json, autostart, restart, depends_on_json, ready_json, preview_port, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            args.projectId,
            args.vmBotId ? `${args.vmBotId}:${args.name}` : args.name,
            args.command,
            args.cwd,
            JSON.stringify(args.env),
            args.autostart ? 1 : 0,
            args.restart,
            JSON.stringify(args.dependsOn),
            args.ready === null ? null : JSON.stringify(args.ready),
            args.previewPort,
            args.createdBy,
            args.now,
            args.now,
          )
      } else {
        database
          .query(
            "UPDATE processes SET command = ?, cwd = ?, env_json = ?, autostart = ?, restart = ?, depends_on_json = ?, ready_json = ?, preview_port = ?, created_by = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            args.command,
            args.cwd,
            JSON.stringify(args.env),
            args.autostart ? 1 : 0,
            args.restart,
            JSON.stringify(args.dependsOn),
            args.ready === null ? null : JSON.stringify(args.ready),
            args.previewPort,
            args.createdBy,
            args.now,
            id,
          )
      }
      database.query("UPDATE processes SET vm_bot_id = ? WHERE id = ?").run(args.vmBotId ?? null, id)
      const spec = getProcessSpec({ processId: id })
      return spec === null
        ? resultError("NOT_FOUND", "Process was inserted but could not be read")
        : { success: true, spec }
    } catch (error) {
      return resultError("PROCESS_EXISTS", error instanceof Error ? error.message : String(error))
    }
  }

  const insertProcessRun = ({
    id,
    processId,
    pid,
    pgid,
    pidStart,
    status,
    logPath,
    startedAt,
  }: Parameters<ProjectStore["insertProcessRun"]>[0]): ProcessRunState => {
    database
      .query(
        "INSERT INTO process_runs (id, process_id, pid, pgid, pid_start, status, ports_json, log_path, started_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)",
      )
      .run(id, processId, pid, pgid, pidStart, status, logPath, startedAt)
    const run = getProcessRun({ runId: id })
    if (run === null) throw new Error("Process run was inserted but could not be read")
    return run
  }

  const updateProcessRun = ({
    runId,
    status,
    exitCode,
    signal,
    ports,
    endedAt,
  }: Parameters<ProjectStore["updateProcessRun"]>[0]): ProcessRunState | null => {
    const current = getProcessRun({ runId })
    if (current === null) return null
    const nextStatus = status ?? current.status
    const nextExitCode = exitCode === undefined ? current.exitCode : exitCode
    const nextSignal = signal === undefined ? current.signal : signal
    const nextPorts = ports ?? current.ports
    const nextEndedAt = endedAt === undefined ? current.endedAt : endedAt
    database
      .query("UPDATE process_runs SET status = ?, exit_code = ?, signal = ?, ports_json = ?, ended_at = ? WHERE id = ?")
      .run(nextStatus, nextExitCode, nextSignal, JSON.stringify(nextPorts), nextEndedAt, runId)
    return getProcessRun({ runId })
  }

  const getProcessRun = ({ runId }: { runId: string }): ProcessRunState | null => {
    const row = asRow(database.query("SELECT * FROM process_runs WHERE id = ?").get(runId))
    return row === null ? null : processRunFromRow(row)
  }

  const getCurrentProcessRun = ({ processId }: { processId: string }): ProcessRunState | null => {
    const row = asRow(
      database
        .query(
          "SELECT * FROM process_runs WHERE process_id = ? AND status IN ('starting','running','ready') ORDER BY started_at DESC LIMIT 1",
        )
        .get(processId),
    )
    return row === null ? null : processRunFromRow(row)
  }

  const getLatestProcessRun = ({ processId }: { processId: string }): ProcessRunState | null => {
    const row = asRow(
      database.query("SELECT * FROM process_runs WHERE process_id = ? ORDER BY started_at DESC LIMIT 1").get(processId),
    )
    return row === null ? null : processRunFromRow(row)
  }

  const getLiveProcessRuns = (): Array<{ run: ProcessRunState; pidStart: string | null }> =>
    (
      database
        .query("SELECT * FROM process_runs WHERE status IN ('starting','running','ready')")
        .all() as Array<unknown>
    )
      .map(asRow)
      .filter((row): row is Row => row !== null)
      .map((row) => ({ run: processRunFromRow(row), pidStart: nullableString(row, "pid_start") }))

  const getProcessLogs = ({ runId, tail }: { runId: string; tail: number }): Array<string> => {
    const path = processRunLogPath({ runId })
    if (path === null) return []
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/)
      if (lines.at(-1) === "") lines.pop()
      return lines.slice(-tail)
    } catch {
      return []
    }
  }

  const processRunLogPath = ({ runId }: { runId: string }): string | null => {
    const row = asRow(database.query("SELECT log_path FROM process_runs WHERE id = ?").get(runId))
    return row === null ? null : nullableString(row, "log_path")
  }

  return {
    listProjects,
    getProject,
    getProjectByPath,
    createProject,
    listSecrets,
    getSecret,
    upsertSecret,
    deleteSecret,
    listProcessSpecs,
    getProcessSpec,
    getProcessSpecByName,
    upsertProcess,
    insertProcessRun,
    updateProcessRun,
    getProcessRun,
    getCurrentProcessRun,
    getLatestProcessRun,
    getLiveProcessRuns,
    getProcessLogs,
    processRunLogPath,
  }
}
