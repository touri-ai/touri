import { readFileSync } from "node:fs"
import { relative } from "node:path"
import type { Kernel, ProcessSpec, ProjectInfo, ToolContext, ToolHandler, ToolResult } from "@touri/contracts"
import { withSecretMutation } from "../approvals/secrets"
import { writePrivateFileAsync } from "../kernel/async-files"
import { runCommand } from "./git"
import { processOwner, saveProcessOwner } from "./ownership"
import { ensureProjectPath } from "./paths"
import { resolveEnvSecret } from "./secrets"
import { createSetupTools } from "./setup-tools"
import type { ProjectStore, Supervisor } from "./types"

type RecordValue = Record<string, unknown>

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null ? (value as RecordValue) : null

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

const resultError = (errorCode: string, error: string): ToolResult => ({ success: false, errorCode, error })

const ok = (value: unknown, label: string): ToolResult => ({
  success: true,
  content: [{ type: "text", text: `${label}\n${JSON.stringify(value)}` }],
  structured: value,
})

const projectFor = ({ store, projectId }: { store: ProjectStore; projectId: string | null }) => {
  return projectId === null ? null : store.getProject(projectId)
}

const parseEntries = (value: unknown): Record<string, string | { secret: string }> | null => {
  const entries = record(value)
  if (entries === null) return null
  const result: Record<string, string | { secret: string }> = {}
  for (const [name, entry] of Object.entries(entries)) {
    if (typeof entry === "string") result[name] = entry
    else {
      const object = record(entry)
      if (object === null || typeof object.secret !== "string") return null
      result[name] = { secret: object.secret }
    }
  }
  return result
}

const dotenvValue = (value: string): string => (/^[A-Za-z0-9_./:@+%-]+$/.test(value) ? value : JSON.stringify(value))

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const createProjectTools = ({
  kernel,
  store,
  supervisor,
  projectInfo,
}: {
  kernel: Kernel
  store: ProjectStore
  supervisor: Supervisor
  projectInfo: (args: { projectId: string; botId?: string }) => Promise<ProjectInfo | null>
}): Array<{ name: string; group: "project" | "process" | "secret" | "preview"; handler: ToolHandler }> => {
  const canAdoptProcess = (spec: ProcessSpec, ctx: ToolContext): boolean => {
    if (spec.vmBotId || processOwner(kernel, spec.id) || spec.createdBy !== "user") return false
    const bot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })

    return !!bot && bot.machine === "local" && bot.access !== "read-only" && bot.projectId === spec.projectId
  }
  const visibleToOwner = (spec: ProcessSpec, ctx: ToolContext): boolean => {
    if (spec.vmBotId) return spec.vmBotId === ctx.botId
    const owner = processOwner(kernel, spec.id)
    if (owner) return owner.botId === ctx.botId

    return canAdoptProcess(spec, ctx)
  }
  const ownsProcess = (spec: ProcessSpec, ctx: ToolContext): boolean => {
    if (spec.vmBotId) return spec.vmBotId === ctx.botId
    const owner = processOwner(kernel, spec.id)
    if (owner) return owner.botId === ctx.botId
    // A user-defined command can be adopted through the router's reviewed
    // mutation. Definitions left by an older agent need an explicit user edit.
    if (!canAdoptProcess(spec, ctx)) return false
    saveProcessOwner(kernel, spec.id, { botId: ctx.botId, machine: "local" })

    return true
  }
  const project_info: ToolHandler = async ({ ctx }) => {
    if (ctx.projectId === null)
      return ok(
        {
          project: null,
          hint: "Nenhum projeto está vinculado a este bot. Um projeto descreve arquivos, processos e Preview; não conecta os dados de uma empresa. Se faltarem dados ou uma ferramenta para atender ao pedido, ofereça anexar um arquivo/CSV, dar acesso a uma pasta ou adicionar uma ferramenta do catálogo. Pergunte qual opção o usuário prefere e termine com uma linha separada: <!-- touri:connect-data -->",
        },
        "Nenhum projeto vinculado.",
      )
    const info = await projectInfo({ projectId: ctx.projectId, botId: ctx.botId })
    const vmBot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm"
    return info === null
      ? resultError("NOT_FOUND", "Project was not found")
      : ok(
          vmBot
            ? {
                ...info,
                project: { ...info.project, path: "/workspace", dataDir: "/workspace/.touri/data" },
                processes: supervisor
                  .list({ projectId: info.project.id })
                  .filter(({ spec }) => spec.vmBotId === ctx.botId)
                  .map(({ spec, run }) => ({
                    name: spec.name,
                    status: run?.status ?? "not-started",
                    ports: run?.ports.map((port) => port.port) ?? [],
                  })),
              }
            : {
                ...info,
                processes: info.processes.filter((process) => {
                  const spec = store.getProcessSpecByName({
                    projectId: info.project.id,
                    name: process.name,
                    vmBotId: null,
                  })

                  return spec !== null && visibleToOwner(spec, ctx)
                }),
                previews: info.previews.filter((preview) => {
                  const spec =
                    preview.processId === null ? null : store.getProcessSpec({ processId: preview.processId })

                  return spec !== null && visibleToOwner(spec, ctx)
                }),
              },
          "Project info",
        )
  }

  const process_define: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.name !== "string" || typeof input.command !== "string")
      return resultError("INVALID_ARGS", "name and command are required")
    const env = parseEntries(input.env ?? {})
    if (env === null) return resultError("INVALID_ARGS", "env must contain literal strings or secret references")
    const dependsOn =
      Array.isArray(input.dependsOn) && input.dependsOn.every((value) => typeof value === "string")
        ? input.dependsOn
        : []
    const ready = input.ready === undefined ? null : (input.ready as Parameters<Supervisor["define"]>[0]["ready"])
    const defined = supervisor.define({
      botId: ctx.botId,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
      project,
      name: input.name,
      command: input.command,
      cwd: typeof input.cwd === "string" ? input.cwd : ".",
      env,
      autostart: boolean(input.autostart, false),
      restart: input.restart === "never" || input.restart === "always" ? input.restart : "on-failure",
      dependsOn,
      ready,
      previewPort: typeof input.previewPort === "number" ? input.previewPort : null,
      createdBy: "agent",
      threadId: ctx.threadId,
    })
    return defined.success
      ? ok(defined.spec, `Process ${defined.spec.name} defined`)
      : resultError(defined.errorCode, defined.error)
  }

  const process_start: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.name !== "string") return resultError("INVALID_ARGS", "name is required")
    const spec = store.getProcessSpecByName({
      projectId: project.id,
      name: input.name,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
    })
    if (spec === null) return resultError("PROCESS_NOT_FOUND", `Process ${input.name} was not found`)
    if (!ownsProcess(spec, ctx)) return resultError("DENIED", "Este processo pertence a outro responsável.")
    const started = await supervisor.start({
      project,
      spec,
      waitMs: number(input.waitMs, 20_000),
      signal: ctx.signal,
      scope: { turnId: ctx.runId, threadId: ctx.threadId, automatic: true },
      ctx,
    })
    return started.success
      ? ok(started.run, `Process ${spec.name} started`)
      : resultError(started.errorCode, started.error)
  }

  const process_stop: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.name !== "string") return resultError("INVALID_ARGS", "name is required")
    const spec = store.getProcessSpecByName({
      projectId: project.id,
      name: input.name,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
    })
    if (spec === null) return resultError("PROCESS_NOT_FOUND", `Process ${input.name} was not found`)
    if (!ownsProcess(spec, ctx)) return resultError("DENIED", "Este processo pertence a outro responsável.")
    const stopped = await supervisor.stop({ processId: spec.id })
    return stopped.success
      ? ok(stopped.run, `Process ${spec.name} stopped`)
      : resultError(stopped.errorCode, stopped.error)
  }

  const process_restart: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.name !== "string") return resultError("INVALID_ARGS", "name is required")
    const spec = store.getProcessSpecByName({
      projectId: project.id,
      name: input.name,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
    })
    if (spec === null) return resultError("PROCESS_NOT_FOUND", `Process ${input.name} was not found`)
    if (!ownsProcess(spec, ctx)) return resultError("DENIED", "Este processo pertence a outro responsável.")
    const restarted = await supervisor.restart({
      project,
      spec,
      waitMs: number(input.waitMs, 20_000),
      scope: { turnId: ctx.runId, threadId: ctx.threadId, automatic: true },
      ctx,
      signal: ctx.signal,
    })
    return restarted.success
      ? ok(restarted.run, `Process ${spec.name} restarted`)
      : resultError(restarted.errorCode, restarted.error)
  }

  const process_list: ToolHandler = async ({ ctx }) => {
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    return ok(
      {
        processes: supervisor
          .list({ projectId: project.id })
          .filter(
            ({ spec }) =>
              spec.vmBotId === ctx.botId ||
              (!spec.vmBotId && processOwner(kernel, spec.id)?.botId === ctx.botId) ||
              canAdoptProcess(spec, ctx),
          ),
      },
      "Processes",
    )
  }

  const process_logs: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.name !== "string") return resultError("INVALID_ARGS", "name is required")
    const spec = store.getProcessSpecByName({
      projectId: project.id,
      name: input.name,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
    })
    if (spec === null) return resultError("PROCESS_NOT_FOUND", `Process ${input.name} was not found`)
    if (!visibleToOwner(spec, ctx)) return resultError("DENIED", "Este processo pertence a outro responsável.")
    const logs =
      typeof input.grep === "string"
        ? supervisor.logs({ processId: spec.id, tail: number(input.tail, 200), grep: input.grep })
        : supervisor.logs({ processId: spec.id, tail: number(input.tail, 200) })
    return logs.success ? ok({ lines: logs.lines }, `Logs for ${spec.name}`) : resultError(logs.errorCode, logs.error)
  }

  const secret_list: ToolHandler = async ({ ctx }) => {
    const names = store.listSecrets({ projectId: ctx.projectId }).map((secret) => secret.name)
    return ok({ names }, "Configured secret names")
  }

  const secret_request: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    if (input === null || typeof input.name !== "string" || typeof input.reason !== "string")
      return resultError("INVALID_ARGS", "name and reason are required")
    const secret = store.getSecret({ projectId: ctx.projectId, name: input.name })
    if (secret === null) return resultError("SECRET_NOT_FOUND", `Secret ${input.name} is not configured`)
    const prompt = await kernel.callHost("secret.prompt", {
      requestId: kernel.newId(),
      title: input.reason.slice(0, 80),
      origin: ctx.projectId ?? "global",
      fieldKinds: ["password"],
    })
    if (!prompt.success) return resultError(prompt.errorCode, prompt.error)
    if (prompt.value.values === null) return resultError("SECRET_NOT_PROVIDED", "The secret card was dismissed")
    const value = prompt.value.values[secret.name] ?? Object.values(prompt.value.values)[0]
    if (value === undefined) return resultError("SECRET_NOT_PROVIDED", "No value was provided")
    kernel.addRedactionValue(value)
    const account = `${ctx.projectId ?? "global"}/${secret.name}`
    return withSecretMutation(kernel, account, async () => {
      const current = store.getSecret({ projectId: ctx.projectId, name: secret.name })
      const bot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })
      if (
        ctx.signal.aborted ||
        current?.id !== secret.id ||
        current.updatedAt !== secret.updatedAt ||
        bot?.projectId !== ctx.projectId ||
        bot.access === "read-only"
      )
        return resultError("DENIED", "A credencial ou a autorização mudou durante a solicitação.")
      const saved = await kernel.callHost("keychain.set", { account, value })
      if (!saved.success) return resultError(saved.errorCode, saved.error)
      const updated = store.upsertSecret({
        projectId: ctx.projectId,
        name: secret.name,
        usage: secret.usage,
        browserOrigin: secret.browserOrigin,
        now: Date.now(),
      })
      if (!updated.success) return resultError(updated.errorCode, updated.error)
      return ok({ name: secret.name, saved: true }, "Secret saved")
    })
  }

  const env_write_file: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null) return resultError("PROJECT_REQUIRED", "This bot has no project configured")
    if (input === null || typeof input.path !== "string") return resultError("INVALID_ARGS", "path is required")
    const entries = parseEntries(input.entries)
    if (entries === null) return resultError("INVALID_ARGS", "entries are required")
    const isVm = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm"
    const machine = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine
    if (machine && machine !== "local" && machine !== "vm")
      return resultError("DENIED", "A exportação de ambiente não está disponível para esta máquina.")
    const vm = isVm ? kernel.services.use("vm.runtime") : null
    if (isVm && !vm) return resultError("VM_UNAVAILABLE", "VM indisponível")
    const guestPath = input.path.startsWith("/") ? input.path : `/workspace/${input.path}`
    if (vm && (!guestPath.startsWith("/workspace/") || guestPath.split("/").includes("..")))
      return resultError("PATH_OUTSIDE_PROJECT", "Caminho fora da VM")
    const target = vm
      ? { success: true as const, path: guestPath }
      : ensureProjectPath({ project, input: input.path, allowDataDir: false })
    if (!target.success) return resultError(target.errorCode, target.error)
    const relativePath = vm ? relative("/workspace", target.path) : relative(project.path, target.path)
    const guestIgnored = vm
      ? await vm.exec({ botId: ctx.botId, command: "git", args: ["check-ignore", "--quiet", "--", relativePath] })
      : null
    const ignored = guestIgnored
      ? { success: guestIgnored.success, output: { code: guestIgnored.success ? guestIgnored.code : 1 } }
      : await runCommand({
          kernel,
          cmd: "git",
          args: ["check-ignore", "--quiet", "--", relativePath],
          cwd: project.path,
        })
    if (!ignored.success || ignored.output.code !== 0)
      return resultError("NOT_GITIGNORED", "Refusing to write a file that is not git-ignored")
    const resolved: Record<string, string> = {}
    const guards: Array<() => boolean> = []
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === "string") {
        resolved[name] = value
        if (value.length >= 6) kernel.addRedactionValue(value)
      } else {
        const fetched = await resolveEnvSecret({
          kernel,
          store,
          ctx,
          projectId: project.id,
          name: value.secret,
          destination: JSON.stringify({
            project: project.id,
            path: target.path,
            variables: Object.keys(entries)
              .filter(
                (key) =>
                  typeof entries[key] !== "string" && (entries[key] as { secret: string }).secret === value.secret,
              )
              .sort(),
          }),
          destinationLabel: target.path,
        })
        if (!fetched.success) return resultError(fetched.errorCode, fetched.error)
        guards.push(fetched.isCurrent)
        resolved[name] = fetched.value
      }
    }
    let content = ""
    if (boolean(input.merge, true)) {
      try {
        if (vm) {
          const existing = await vm.exec({ botId: ctx.botId, command: "cat", args: [target.path] })
          content = existing.success ? existing.stdout : ""
        } else content = readFileSync(target.path, "utf8")
      } catch {
        content = ""
      }
    }
    const lines = content.split(/\r?\n/)
    for (const [name, value] of Object.entries(resolved)) {
      const index = lines.findIndex((line) => new RegExp(`^\\s*${escapeRegExp(name)}\\s*=`).test(line))
      const next = `${name}=${dotenvValue(value)}`
      if (index >= 0) lines[index] = next
      else lines.push(next)
    }
    if (ctx.signal.aborted || guards.some((guard) => !guard()))
      return resultError("DENIED", "A autorização da credencial mudou.")
    if (vm) {
      await vm.writeFile({ botId: ctx.botId, path: target.path, content: `${lines.join("\n").replace(/\n+$/, "")}\n` })
      return ok({ path: target.path, names: Object.keys(resolved) }, "Environment file written inside VM")
    }
    await writePrivateFileAsync({
      root: project.path,
      path: target.path,
      content: `${lines.join("\n").replace(/\n+$/, "")}\n`,
    })
    return ok({ path: relativePath, names: Object.keys(resolved) }, "Environment file written")
  }

  const preview_open: ToolHandler = async ({ ctx, args }) => {
    const input = record(args)
    const project = projectFor({ store, projectId: ctx.projectId })
    if (project === null)
      return resultError(
        "PROJECT_REQUIRED",
        "Nenhum Preview foi criado. O Preview exige um projeto vinculado e um processo HTTP supervisionado deste bot. Ofereça vincular a pasta do aplicativo com project_link({path}), aguarde a aprovação explícita do usuário e use process_define/process_start antes de preview_open. Um servidor iniciado pelo terminal não aparece no Preview.",
      )
    const opened = supervisor.openPreview({
      botId: ctx.botId,
      vmBotId: kernel.services.use("store.api")?.getBot({ botId: ctx.botId })?.machine === "vm" ? ctx.botId : null,
      project,
      ...(typeof input?.port === "number" ? { port: input.port } : {}),
      ...(typeof input?.process === "string" ? { processName: input.process } : {}),
      path: typeof input?.path === "string" ? input.path : "/",
    })
    return opened.success
      ? ok(opened.preview, "Preview disponível no touri. Abra o painel Preview para visualizar o aplicativo.")
      : resultError(opened.errorCode, opened.error)
  }

  return [
    { name: "project_info", group: "project", handler: project_info },
    ...createSetupTools({ kernel, store }),
    { name: "process_define", group: "process", handler: process_define },
    { name: "process_start", group: "process", handler: process_start },
    { name: "process_stop", group: "process", handler: process_stop },
    { name: "process_restart", group: "process", handler: process_restart },
    { name: "process_list", group: "process", handler: process_list },
    { name: "process_logs", group: "process", handler: process_logs },
    { name: "secret_list", group: "secret", handler: secret_list },
    { name: "secret_request", group: "secret", handler: secret_request },
    { name: "env_write_file", group: "secret", handler: env_write_file },
    { name: "preview_open", group: "preview", handler: preview_open },
  ]
}
