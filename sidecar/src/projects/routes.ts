import { existsSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import type { Kernel, ProjectInfo, RouteModule } from "@touri/contracts"
import { discoverProjects } from "./discovery"
import { cloneName, cloneProject, cloneSource, gitStatus, inspectGit, projectHints } from "./git"
import { processCwd } from "./paths"
import type { ProjectStore, Supervisor } from "./types"

type RecordValue = Record<string, unknown>

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null ? (value as RecordValue) : null

const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

const projectName = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) return null
  return trimmed
}

const errorResponse = (errorCode: string, error: string, status = 400): { status: number; json: unknown } => ({
  status,
  json: { errorCode, error },
})

const statusFor = (errorCode: string): number => {
  if (errorCode === "NOT_FOUND" || errorCode === "PROCESS_NOT_FOUND" || errorCode === "SECRET_NOT_FOUND") return 404
  if (errorCode === "PROJECT_EXISTS" || errorCode === "PROCESS_EXISTS" || errorCode === "PROCESS_CYCLE") return 409
  if (errorCode === "PATH_OUTSIDE_PROJECT" || errorCode === "NOT_GITIGNORED") return 422
  return 400
}

const readProjectInfo = async ({
  kernel,
  store,
  supervisor,
  projectId,
  botId,
}: {
  kernel: Kernel
  store: ProjectStore
  supervisor: Supervisor
  projectId: string
  botId?: string
}): Promise<ProjectInfo | null> => {
  const project = store.getProject(projectId)
  if (project === null) return null
  if (botId && kernel.services.use("store.api")?.getBot({ botId })?.machine === "vm") {
    const vm = kernel.services.use("vm.runtime")
    if (!vm) return null
    const [branch, status, commit, remote] = await Promise.all([
      vm.exec({ botId, command: "git", args: ["branch", "--show-current"] }),
      vm.exec({ botId, command: "git", args: ["status", "--porcelain"] }),
      vm.exec({ botId, command: "git", args: ["rev-parse", "HEAD"] }),
      vm.exec({ botId, command: "git", args: ["remote", "get-url", "origin"] }),
    ])
    return {
      project: { ...project, path: "/workspace", dataDir: "/workspace/.touri/data" },
      git:
        branch.success && status.success
          ? {
              branch: branch.stdout.trim(),
              dirty: Boolean(status.stdout.trim()),
              ahead: 0,
              behind: 0,
              commit: commit.success ? commit.stdout.trim() : null,
              remote: remote.success ? remote.stdout.trim() : project.gitRemote,
            }
          : null,
      hints: [],
      processes: supervisor
        .list({ projectId })
        .filter(({ spec }) => spec.vmBotId === botId)
        .map(({ spec, run }) => ({
          name: spec.name,
          status: run?.status ?? "not-started",
          ports: run?.ports.map((port) => port.port) ?? [],
        })),
      previews: supervisor.previews({ projectId }).filter((preview) => preview.vmBotId === botId),
      secretNames: store.listSecrets({ projectId }).map((secret) => secret.name),
    }
  }
  const git = await gitStatus({ kernel, project })
  const processes = supervisor.list({ projectId }).map(({ spec, run }) => ({
    name: spec.name,
    status: run?.status ?? ("not-started" as const),
    ports: run?.ports.map((port) => port.port) ?? [],
  }))
  return {
    project,
    git: git.success
      ? {
          branch: git.branch,
          dirty: git.dirty,
          ahead: git.ahead,
          behind: git.behind,
          commit: git.commit,
          remote: git.remote,
        }
      : null,
    hints: projectHints({ project }),
    processes,
    previews: supervisor.previews({ projectId }),
    secretNames: store.listSecrets({ projectId }).map((secret) => secret.name),
  }
}

export const createProjectRoutes = ({
  kernel,
  store,
  supervisor,
  discoveryHome,
}: {
  kernel: Kernel
  store: ProjectStore
  supervisor: Supervisor
  discoveryHome?: string
}): RouteModule => {
  const routes: RouteModule["routes"] = [
    {
      method: "GET",
      path: "/projects/discover",
      handler: async ({ signal }) => ({
        status: 200,
        json: {
          repositories: await discoverProjects({
            ...(discoveryHome ? { home: discoveryHome } : {}),
            registeredPaths: store.listProjects().map((project) => project.path),
            signal,
          }),
        },
      }),
    },
    {
      method: "GET",
      path: "/projects",
      handler: async () => ({ status: 200, json: { projects: store.listProjects() } }),
    },
    {
      method: "POST",
      path: "/projects",
      handler: async ({ body, signal }) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
        try {
          const input = record(body)
          if (input === null) return errorResponse("INVALID_ARGS", "Project body must be an object")
          let projectPath: string
          let name: string
          const requestedName = projectName(input.name)
          if (input.name !== undefined && requestedName === null)
            return errorResponse("INVALID_ARGS", "Project name must be a non-empty folder-safe name")
          if (typeof input.path === "string") {
            if (!isAbsolute(input.path))
              return errorResponse("PROJECT_PATH_INVALID", "Escolha uma pasta com caminho absoluto.")
            try {
              projectPath = realpathSync(input.path)
              if (!statSync(projectPath).isDirectory())
                return errorResponse("PROJECT_PATH_INVALID", "O caminho precisa ser uma pasta.")
            } catch {
              return errorResponse("PROJECT_PATH_INVALID", "A pasta não existe ou não está acessível.")
            }
            const existing = store.getProjectByPath(projectPath)
            if (existing) return { status: 200, json: { project: existing } }
            name = requestedName ?? basename(projectPath)
          } else if (typeof input.gitUrl === "string" && typeof input.parentDir === "string") {
            const source = cloneSource(input.gitUrl)
            if (!source) return errorResponse("GIT_SOURCE_UNSUPPORTED", "Use HTTPS, SSH ou um repositório Git local.")
            try {
              if (!isAbsolute(input.parentDir))
                return errorResponse("PROJECT_PATH_INVALID", "Escolha uma pasta com caminho absoluto.")
              const parent = realpathSync(input.parentDir)
              if (!statSync(parent).isDirectory())
                return errorResponse("PROJECT_PATH_INVALID", "O destino precisa ser uma pasta.")
              name = requestedName ?? cloneName({ url: source })
              if (!projectName(name))
                return errorResponse("INVALID_ARGS", "Informe um nome válido para a pasta de destino.")
              projectPath = join(parent, name)
              if (existsSync(projectPath))
                return errorResponse("CLONE_DESTINATION_EXISTS", "A pasta de destino já existe.", 409)
            } catch {
              return errorResponse("PROJECT_PATH_INVALID", "A pasta de destino não existe ou não está acessível.")
            }
            const cloned = await cloneProject({ kernel, url: source, destination: projectPath, signal: deadline })
            if (deadline.aborted) return errorResponse("GIT_TIMEOUT", "O Git não respondeu no prazo.", 504)
            if (!cloned.success) return errorResponse(cloned.errorCode, cloned.error, statusFor(cloned.errorCode))
            try {
              projectPath = realpathSync(projectPath)
              // Keep the user-facing name supplied to the route. The clone destination may
              // have been normalized by git, but the display name is still explicit.
              name = requestedName ?? basename(projectPath)
            } catch (error) {
              return errorResponse("GIT_FAILED", error instanceof Error ? error.message : String(error))
            }
          } else {
            return errorResponse("INVALID_ARGS", "Provide path or gitUrl and parentDir")
          }
          const git = await inspectGit({ kernel, projectPath, signal: deadline })
          if (deadline.aborted) return errorResponse("GIT_TIMEOUT", "O Git não respondeu no prazo.", 504)
          const projectId = kernel.newId()
          const project = await store.createProject({
            id: projectId,
            name,
            path: projectPath,
            gitRemote: git?.remote ?? null,
            defaultBranch: git?.defaultBranch ?? null,
            dataDir: join(kernel.paths.projectsDir, projectId),
            now: Date.now(),
          })
          return project.success
            ? { status: 201, json: { project: project.project } }
            : errorResponse(project.errorCode, project.error, statusFor(project.errorCode))
        } catch (error) {
          kernel.log({
            level: "error",
            module: "projects",
            msg: "Falha ao conectar projeto",
            data: { error: kernel.redact(error instanceof Error ? error.message : String(error)) },
          })
          return errorResponse("PROJECT_CONNECT_FAILED", "Não foi possível conectar o projeto.", 500)
        }
      },
    },
    {
      method: "GET",
      path: "/projects/:id/git",
      handler: async ({ params }) => {
        const project = store.getProject(params.id ?? "")
        if (!project) return errorResponse("NOT_FOUND", "Project was not found", 404)
        const status = await gitStatus({ kernel, project })
        return status.success
          ? {
              status: 200,
              json: {
                branch: status.branch,
                dirty: status.dirty,
                ahead: status.ahead,
                behind: status.behind,
                commit: status.commit,
                remote: status.remote,
              },
            }
          : errorResponse(status.errorCode, status.error, statusFor(status.errorCode))
      },
    },
    {
      method: "GET",
      path: "/projects/:id/secrets",
      handler: async ({ params }) => {
        if (!store.getProject(params.id ?? "")) return errorResponse("NOT_FOUND", "Project was not found", 404)
        return { status: 200, json: { secrets: store.listSecrets({ projectId: params.id ?? null }) } }
      },
    },
    {
      method: "PUT",
      path: "/projects/:id/secrets/:name",
      handler: async ({ params, body }) => {
        if (!store.getProject(params.id ?? "")) return errorResponse("NOT_FOUND", "Project was not found", 404)
        const input = record(body)
        const usage = record(input?.usage)
        if (usage === null || typeof usage.env !== "boolean" || typeof usage.browser !== "boolean")
          return errorResponse("INVALID_ARGS", "usage.env and usage.browser are required")
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(params.name ?? ""))
          return errorResponse("INVALID_ARGS", "Invalid secret name")
        const browserOrigin = typeof input?.browserOrigin === "string" ? input.browserOrigin : null
        if (usage.browser && browserOrigin === null)
          return errorResponse("INVALID_ARGS", "browserOrigin is required for browser secrets")
        const secret = store.upsertSecret({
          projectId: params.id ?? null,
          name: params.name ?? "",
          usage: { env: usage.env, browser: usage.browser },
          browserOrigin,
          now: Date.now(),
        })
        return secret.success
          ? { status: 200, json: { secret: secret.secret } }
          : errorResponse(secret.errorCode, secret.error, statusFor(secret.errorCode))
      },
    },
    {
      method: "DELETE",
      path: "/projects/:id/secrets/:name",
      handler: async ({ params }) => {
        const deleted = await store.deleteSecret({ projectId: params.id ?? null, name: params.name ?? "" })
        return deleted.success
          ? { status: 200, json: {} }
          : errorResponse(deleted.errorCode, deleted.error, statusFor(deleted.errorCode))
      },
    },
    {
      method: "GET",
      path: "/projects/:id/processes",
      handler: async ({ params, query }) => {
        if (!store.getProject(params.id ?? "")) return errorResponse("NOT_FOUND", "Project was not found", 404)
        return {
          status: 200,
          json: {
            processes: supervisor
              .list({ projectId: params.id ?? "" })
              .filter(({ spec }) => (spec.vmBotId ?? "") === (query.vmBotId ?? "")),
          },
        }
      },
    },
    {
      method: "PUT",
      path: "/projects/:id/processes/:name",
      handler: async ({ params, body }) => {
        const project = store.getProject(params.id ?? "")
        if (!project) return errorResponse("NOT_FOUND", "Project was not found", 404)
        const input = record(body)
        if (input === null || typeof input.command !== "string")
          return errorResponse("INVALID_ARGS", "command is required")
        const env = (record(input.env) ?? {}) as Parameters<Supervisor["define"]>[0]["env"]
        const vmBotId = typeof input.vmBotId === "string" ? input.vmBotId : null
        const cwd = vmBotId
          ? { success: true as const, path: typeof input.cwd === "string" ? input.cwd : "." }
          : processCwd({ project, cwd: typeof input.cwd === "string" ? input.cwd : "." })
        if (!cwd.success) return errorResponse(cwd.errorCode, cwd.error, statusFor(cwd.errorCode))
        const defined = supervisor.define({
          vmBotId,
          project,
          name: params.name ?? "",
          command: input.command,
          cwd: cwd.path,
          env,
          autostart: boolean(input.autostart, false),
          restart: input.restart === "never" || input.restart === "always" ? input.restart : "on-failure",
          dependsOn:
            Array.isArray(input.dependsOn) && input.dependsOn.every((value) => typeof value === "string")
              ? input.dependsOn
              : [],
          ready: input.ready === undefined ? null : (input.ready as Parameters<Supervisor["define"]>[0]["ready"]),
          previewPort: typeof input.previewPort === "number" ? input.previewPort : null,
          createdBy: "user",
        })
        return defined.success
          ? { status: 200, json: { spec: defined.spec } }
          : errorResponse(defined.errorCode, defined.error, statusFor(defined.errorCode))
      },
    },
    {
      method: "POST",
      path: "/processes/:id/start",
      handler: async ({ params, signal }) => {
        const spec = store.getProcessSpec({ processId: params.id ?? "" })
        if (!spec) return errorResponse("PROCESS_NOT_FOUND", "Process was not found", 404)
        const project = store.getProject(spec.projectId)
        if (!project) return errorResponse("NOT_FOUND", "Project was not found", 404)
        const started = await supervisor.start({ project, spec, waitMs: 20_000, signal })
        return started.success
          ? { status: 200, json: { run: started.run } }
          : errorResponse(started.errorCode, started.error, statusFor(started.errorCode))
      },
    },
    {
      method: "POST",
      path: "/processes/:id/stop",
      handler: async ({ params }) => {
        const stopped = await supervisor.stop({ processId: params.id ?? "" })
        return stopped.success
          ? { status: 200, json: { run: stopped.run } }
          : errorResponse(stopped.errorCode, stopped.error, statusFor(stopped.errorCode))
      },
    },
    {
      method: "POST",
      path: "/processes/:id/restart",
      handler: async ({ params }) => {
        const spec = store.getProcessSpec({ processId: params.id ?? "" })
        if (!spec) return errorResponse("PROCESS_NOT_FOUND", "Process was not found", 404)
        const project = store.getProject(spec.projectId)
        if (!project) return errorResponse("NOT_FOUND", "Project was not found", 404)
        const restarted = await supervisor.restart({ project, spec, waitMs: 20_000 })
        return restarted.success
          ? { status: 200, json: { run: restarted.run } }
          : errorResponse(restarted.errorCode, restarted.error, statusFor(restarted.errorCode))
      },
    },
    {
      method: "GET",
      path: "/processes/:id/logs",
      handler: async ({ params, query }) => {
        const logs = supervisor.logs({
          processId: params.id ?? "",
          tail: Math.min(2000, Math.max(1, Number(query.tail ?? "200"))),
        })
        return logs.success
          ? { status: 200, json: { lines: logs.lines } }
          : errorResponse(logs.errorCode, logs.error, statusFor(logs.errorCode))
      },
    },
    {
      method: "GET",
      path: "/previews",
      handler: async ({ query }) =>
        query.projectId === undefined
          ? { status: 200, json: { previews: supervisor.previews() } }
          : { status: 200, json: { previews: supervisor.previews({ projectId: query.projectId }) } },
    },
  ]
  return { name: "projects", routes }
}

export const createProjectInfo =
  ({
    kernel,
    store,
    supervisor,
  }: {
    kernel: Kernel
    store: ProjectStore
    supervisor: Supervisor
  }): ((args: { projectId: string; botId?: string }) => Promise<ProjectInfo | null>) =>
  (args) =>
    readProjectInfo({ kernel, store, supervisor, ...args })
