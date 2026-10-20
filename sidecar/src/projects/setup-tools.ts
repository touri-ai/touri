import { lstatSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path"
import {
  type Bot,
  getHostNoun,
  type HostKind,
  type Kernel,
  type ToolContext,
  type ToolRegistration,
  type ToolResult,
} from "@touri/contracts"
import { getDelegation } from "../groups/security"
import { createWorkspaceDirectoryAsync } from "../kernel/async-files"
import { canonicalPath, excludedBotFolders, parseBotFolders, withinFolder } from "../kernel/bot-folders"
import { folderAccessUnavailable, refreshHostFolderAccess } from "../kernel/folder-capability"
import { getHost } from "../platform/host"
import { createCapabilityTools } from "./capability-tools"
import { discoverProjects } from "./discovery"
import { inspectGitMetadata } from "./git"
import type { ProjectStore } from "./types"

const denied = (error: string): ToolResult => ({ success: false, errorCode: "DENIED", error })
const ok = (value: unknown, text: string): ToolResult => ({
  success: true,
  content: [{ type: "text", text: `${text}\n${JSON.stringify(value)}` }],
  structured: value,
})
const snapshot = (bot: Bot) =>
  JSON.stringify([
    bot.projectId,
    bot.folders ?? [],
    bot.anyFolderAccess ?? false,
    bot.machine,
    bot.provider,
    bot.access,
    bot.approvals,
  ])

const absolutePath = (value: string): string => {
  const path = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path) || /[\0\n\r*]/.test(path))
    throw new Error(`Informe o caminho absoluto de uma pasta deste ${getHostNoun(getHost())}.`)
  return path
}

const hostPath = (value: string, allowRoot = false): string => {
  const path = absolutePath(value)
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error("O caminho precisa ser uma pasta.")
  if (!allowRoot && canonical === parse(canonical).root)
    throw new Error(`O acesso a qualquer pasta deste ${getHostNoun(getHost())} é exclusivo dos ajustes.`)
  return canonical
}

const folderRequestPath = (value: string): string => {
  const source = absolutePath(value)
  if (source.split("/").includes("..")) throw new Error("Informe um caminho sem '..'.")
  return source
}

const folderTarget = (value: string) => {
  const source = folderRequestPath(value)
  let ancestor = source
  const missing: string[] = []
  for (;;) {
    try {
      lstatSync(ancestor)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Não foi possível acessar a pasta. Verifique o caminho e as permissões.")
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
  const root = hostPath(ancestor)
  const info = statSync(root)
  return { path: join(root, ...missing), ancestor: root, missing: missing.length > 0, dev: info.dev, ino: info.ino }
}

export const createSetupTools = ({
  kernel,
  store,
  host = getHost(),
}: {
  kernel: Kernel
  store: ProjectStore
  host?: HostKind
}): Array<ToolRegistration & { group: "project" }> => {
  const api = () => kernel.services.use("store.api")
  const self = (ctx: ToolContext): Bot | null => {
    const isAdminRun = kernel.services.use("work.isAdminRun")
    if (isAdminRun && (!ctx.runId || !isAdminRun(ctx.runId))) return null
    const bot = api()?.getBot({ botId: ctx.botId })
    // A peer's delegated request cannot persist changes outside its ceiling.
    if (ctx.signal.aborted || getDelegation(kernel, ctx.threadId)) return null
    return bot && api()?.getThread({ threadId: ctx.threadId })?.botId === bot.id ? bot : null
  }
  const alreadyWritable = (bot: Bot, ctx: ToolContext, path: string): boolean => {
    if (bot.machine !== "local") return false
    if (bot.access === "full") return true
    if (bot.access === "read-only") return false
    const explicit = bot.folders ?? []
    const inside = (root: string) => withinFolder(canonicalPath(root), path)
    if (explicit.some((folder) => folder.access === "read-only" && inside(folder.path))) return false
    const project = bot.projectId ? store.getProject(bot.projectId) : null
    const internal = [bot.homeDir, ...(project ? [project.dataDir] : [])]
    if (excludedBotFolders(kernel.paths.appData).some((excluded) => withinFolder(excluded, path))) {
      if (!internal.some(inside) && !explicit.some((folder) => inside(folder.path))) return false
    }
    const thread = api()?.getThread({ threadId: ctx.threadId })
    // Runtime chooses the first usable candidate. By tool-call time its cwd
    // already exists; do not create directories while checking a no-op.
    const cwd =
      [thread?.cwdOverride, bot.cwd, project?.path].find((candidate) => {
        if (!candidate) return false
        try {
          return statSync(candidate).isDirectory()
        } catch {
          return false
        }
      }) ?? bot.homeDir
    return (
      bot.anyFolderAccess === true ||
      [
        bot.homeDir,
        cwd,
        ...(project ? [project.dataDir] : []),
        ...explicit.filter((folder) => folder.access === "read-write").map((folder) => folder.path),
      ].some(inside)
    )
  }
  const unchangedAccess = (bot: Bot, path: string, projectLink = false): ToolResult => {
    const message =
      bot.machine === "local" && bot.access === "full"
        ? "Este bot já tem acesso total aos arquivos deste computador. Continue a tarefa diretamente e crie as pastas necessárias com suas ferramentas. Não é preciso pedir autorização de pasta. As permissões do sistema operacional continuam valendo."
        : "Este bot já tem acesso a esta pasta. Nenhuma permissão foi alterada."
    const nextStep = "Para usar processos supervisionados e o Preview, vincule o projeto nas configurações do bot."
    return {
      success: true,
      content: [{ type: "text", text: projectLink ? `${message} ${nextStep}` : message }],
      structured: {
        path,
        projectId: bot.projectId,
        alreadyAccessible: true,
        unchanged: true,
        automaticContinuation: false,
        effective: "current-turn",
      },
    }
  }
  const changed = async (
    bot: Bot,
    patch: Partial<Pick<Bot, "projectId" | "folders">>,
    text: string,
    context: ToolContext,
    approvedContext?: ToolContext,
  ) => {
    const configure = kernel.services.use("bots.configureAccess")
    if (!configure) return denied("A configuração do bot está indisponível.")
    const result = await configure({ botId: bot.id, patch, ...(context.runId ? { runId: context.runId } : {}) })
    if (!result.success) return result
    const automatic =
      approvedContext && snapshot(bot) !== snapshot(result.bot)
        ? kernel.services.use("runtime.continueAfterApproval")?.(approvedContext) === true
        : false
    const timing =
      bot.machine === "vm"
        ? `${text} Vale a partir da próxima mensagem na VM.`
        : bot.machine === "local"
          ? `${text} A configuração foi salva neste ${getHostNoun(host)}. Vale a partir da próxima mensagem.`
          : text
    const message = automatic
      ? `${timing} Encerre sua resposta agora, sem falar em turnos nem em retomada: o touri retoma a tarefa sozinho com a configuração aprovada e avisa o usuário.`
      : timing
    return {
      success: true as const,
      content: [{ type: "text" as const, text: message }],
      structured: {
        projectId: result.bot.projectId,
        folders: result.bot.folders,
        effective: "next-turn",
        automaticContinuation: automatic,
        message,
      },
    }
  }
  const notice = (ctx: ToolContext, text: string) => {
    const thread = api()?.getThread({ threadId: ctx.threadId })
    if (!thread) return
    const result = api()?.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: thread.id,
        parentId: thread.activeLeafId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: ctx.runId,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (result?.success) kernel.publish({ type: "message.created", message: result.message })
  }
  const approve = async (
    ctx: ToolContext,
    bot: Bot,
    toolName: string,
    input: unknown,
    targetCurrent: () => boolean,
  ): Promise<(() => boolean) | null> => {
    const reviewed = snapshot(bot)
    const current = () => {
      const latest = self(ctx)
      return !!latest && snapshot(latest) === reviewed && targetCurrent()
    }
    const result = await kernel.services.use("approvals.present")?.({
      ctx,
      scope: { source: "mcp", server: "touri", tool: toolName },
      toolName,
      input,
      allowStanding: false,
      isCurrent: current,
    })
    return result?.success === true && result.behavior === "allow" ? current : null
  }

  return [
    ...createCapabilityTools(kernel),
    {
      name: "bot_rename",
      group: "project",
      handler: async ({ ctx, args }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot, sem delegação, pode alterar seu nome.")
        const rename = kernel.services.use("bots.rename")
        if (!rename) return denied("A configuração do bot está indisponível.")
        const result = rename({ botId: bot.id, name: (args as { name: string }).name })
        if (!result.success) return result
        const message = `Bot renomeado de ${JSON.stringify(bot.name)} para ${JSON.stringify(result.bot.name)}.`
        notice(ctx, message)
        return ok({ name: result.bot.name }, message)
      },
    },
    {
      name: "project_discover",
      group: "project",
      handler: async ({ ctx }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot, sem delegação, pode consultar suas pastas.")
        const reviewed = snapshot(bot)
        const connected = bot.projectId ? store.getProject(bot.projectId) : null
        const explicit = bot.folders ?? []
        const exclusions = excludedBotFolders(kernel.paths.appData)
        const isAllowed = (path: string) =>
          !exclusions.some(
            (excluded) =>
              withinFolder(excluded, path) &&
              !explicit.some((folder) => withinFolder(excluded, folder.path) && withinFolder(folder.path, path)),
          )
        const roots = [
          ...(bot.folders ?? []).map((folder) => folder.path),
          ...(connected ? [connected.path] : []),
        ].filter((path) => {
          try {
            return isAllowed(path) && hostPath(path) === path
          } catch {
            return false
          }
        })
        const projects = store
          .listProjects()
          .filter((project) => isAllowed(project.path) && roots.some((root) => withinFolder(root, project.path)))
        const repositories = await discoverProjects({
          roots,
          isAllowed,
          registeredPaths: projects.map((project) => project.path),
          signal: ctx.signal,
        })
        const latest = self(ctx)
        if (!latest || snapshot(latest) !== reviewed)
          return denied("A configuração mudou durante a busca. Tente novamente.")
        return ok(
          {
            projects,
            repositories,
          },
          "Projetos e repositórios nas pastas já permitidas a este bot.",
        )
      },
    },
    {
      name: "project_link",
      group: "project",
      handler: async ({ ctx, args }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot, sem delegação, pode alterar sua configuração.")
        const input = args as { path?: string; projectId?: string }
        try {
          const registered = input.projectId ? store.getProject(input.projectId) : null
          if (input.projectId && (!registered || registered.archivedAt !== null))
            return { success: false, errorCode: "NOT_FOUND", error: "Projeto não encontrado." }
          const source = registered?.path ?? input.path ?? ""
          // Like folder_access_request, confirming full local access must not
          // depend on the target existing or being inspectable by this process.
          if (bot.machine === "local" && bot.access === "full") return unchangedAccess(bot, absolutePath(source), true)
          const path = hostPath(source)
          const project = registered ?? store.getProjectByPath(path)
          if (project && bot.projectId === project.id && project.path === path) return unchangedAccess(bot, path)
          if (alreadyWritable(bot, ctx, path)) return unchangedAccess(bot, path, true)
          const name = project?.name ?? basename(path)
          const previous = bot.projectId ? store.getProject(bot.projectId) : null
          const targetCurrent = () => {
            try {
              const latest = project ? store.getProject(project.id) : store.getProjectByPath(path)
              return hostPath(source) === path && JSON.stringify(latest) === JSON.stringify(project)
            } catch {
              return false
            }
          }
          const authorized = await approve(
            ctx,
            bot,
            "project_link",
            {
              path,
              requestedPath: input.path ?? null,
              name,
              projectId: project?.id ?? null,
              previousProject: previous ? { name: previous.name, path: previous.path } : null,
              nextTurn: bot.machine !== "cloud",
              machine: bot.machine,
            },
            targetCurrent,
          )
          if (!authorized?.()) return denied("O vínculo não foi aprovado ou a configuração mudou.")
          const git = project ? null : await inspectGitMetadata({ kernel, projectPath: path, signal: ctx.signal })
          if (!authorized()) return denied("O vínculo não foi aprovado ou a configuração mudou.")
          // Registration happens only after consent, using the same repository
          // path as POST /projects. No await may separate the guard and writes.
          let linked = project
          if (!linked) {
            const id = kernel.newId()
            const created = await store.createProject({
              id,
              name,
              path,
              gitRemote: git?.remote ?? null,
              defaultBranch: git?.defaultBranch ?? null,
              dataDir: join(kernel.paths.projectsDir, id),
              now: Date.now(),
            })
            if (!created.success) return created
            linked = created.project
          }
          return changed(bot, { projectId: linked.id }, `Projeto ${name} (${path}) vinculado a este bot.`, ctx, ctx)
        } catch (error) {
          return {
            success: false,
            errorCode: "INVALID_ARGS",
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    },
    {
      name: "folder_access_request",
      group: "project",
      handler: async ({ ctx, args }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot, sem delegação, pode alterar sua configuração.")
        if (bot.machine === "cloud") return denied(`Pastas deste ${getHostNoun(host)} não estão disponíveis na nuvem.`)
        const input = args as { path: string; mode: "read" | "read-write" }
        try {
          const source = folderRequestPath(input.path)
          // Full local access is a policy choice, independent of whether this
          // path exists or can currently be inspected. A grant cannot repair
          // OS permissions; tell the bot to continue under its existing policy.
          if (bot.machine === "local" && bot.access === "full") return unchangedAccess(bot, source)
          const target = folderTarget(source)
          // Do not turn existing write access into a persisted restriction. This
          // is also safe for missing output directories: the bot can create them
          // directly under its current policy, without changing configuration.
          if (alreadyWritable(bot, ctx, target.path)) return unchangedAccess(bot, target.path)
          const explicit = bot.folders ?? []
          const roots = [
            ...explicit.map((folder) => folder.path),
            bot.homeDir,
            ...(bot.projectId ? [store.getProject(bot.projectId)?.path ?? ""] : []),
          ].filter(Boolean)
          if (target.missing && !roots.some((root) => withinFolder(root, target.ancestor)) && !bot.anyFolderAccess)
            return denied(
              "A pasta não existe e fica fora das pastas permitidas. Solicite primeiro acesso à pasta existente.",
            )
          if (
            target.missing &&
            excludedBotFolders(kernel.paths.appData).some(
              (excluded) =>
                withinFolder(excluded, target.path) &&
                !explicit.some(
                  (folder) => withinFolder(excluded, folder.path) && withinFolder(folder.path, target.path),
                ),
            )
          )
            return denied("Esta pasta é protegida. Solicite primeiro acesso à pasta existente.")
          if (target.missing && input.mode === "read")
            return denied("A pasta ainda não existe. Solicite acesso de leitura e escrita para criá-la.")
          if (target.missing && bot.access === "read-only")
            return denied("O bot está em modo somente leitura e não pode criar pastas.")
          if (bot.machine === "local" && !(await refreshHostFolderAccess())) return denied(folderAccessUnavailable)
          // A read-only ancestor wins over a narrower writable grant in every sandbox.
          const readonly = explicit
            .filter((folder) => folder.access === "read-only" && withinFolder(folder.path, target.path))
            .sort((a, b) => a.path.length - b.path.length)[0]
          const path = input.mode === "read-write" ? (readonly?.path ?? target.ancestor) : target.path
          const access = input.mode === "read" ? "read-only" : "read-write"
          const grantInfo = statSync(path)
          const previousAccess = bot.folders?.find((folder) => folder.path === path)?.access
          const targetCurrent = () => {
            try {
              const info = statSync(path)
              return (
                JSON.stringify(folderTarget(input.path)) === JSON.stringify(target) &&
                hostPath(path) === path &&
                info.dev === grantInfo.dev &&
                info.ino === grantInfo.ino
              )
            } catch {
              return false
            }
          }
          const authorized = await approve(
            ctx,
            bot,
            "folder_access_request",
            {
              path,
              requestedPath: input.path,
              mode: input.mode,
              previousMode: previousAccess ?? null,
              writeApproval: input.mode === "read-write" && (!!readonly || target.missing),
              ...(target.missing ? { createPath: target.path } : {}),
              nextTurn: true,
              machine: bot.machine,
            },
            targetCurrent,
          )
          if (!authorized?.())
            return denied(
              "O acesso não foi aprovado ou a configuração mudou. Nenhuma pasta foi criada e as permissões foram mantidas.",
            )
          if (bot.machine === "local" && !(await refreshHostFolderAccess())) return denied(folderAccessUnavailable)
          // Walking the requested tree and revalidating existing grants require
          // consent too. Keep the final guard adjacent to the configuration write.
          const folders = parseBotFolders([
            ...explicit
              .filter((folder) => folder.path !== path)
              .map((folder) =>
                access === "read-write" && withinFolder(path, folder.path) ? { ...folder, access } : folder,
              ),
            { path, access },
          ])
          if (!authorized()) return denied("O acesso não foi aprovado ou a configuração mudou.")
          const result = await changed(
            bot,
            { folders },
            `Acesso ${input.mode === "read" ? "de leitura" : "de leitura e escrita"} à pasta ${path} concedido a este bot.${target.missing ? ` Pasta ${target.path} criada.` : ""}`,
            ctx,
            previousAccess !== access && (access === "read-write" || !previousAccess) ? ctx : undefined,
          )
          if (result.success && target.missing)
            await createWorkspaceDirectoryAsync({
              root: target.ancestor,
              path: relative(target.ancestor, target.path),
              identity: target,
            })
          return result
        } catch (error) {
          return {
            success: false,
            errorCode: "INVALID_ARGS",
            error:
              error instanceof Error && "code" in error
                ? "Não foi possível acessar ou criar a pasta. Verifique o caminho e as permissões e tente novamente."
                : error instanceof Error
                  ? error.message
                  : String(error),
          }
        }
      },
    },
    {
      name: "project_unlink",
      group: "project",
      handler: async ({ ctx }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot pode alterar sua configuração.")
        const project = bot.projectId ? store.getProject(bot.projectId) : null
        const result = await changed(
          bot,
          { projectId: null },
          `Projeto ${project?.name ?? "atual"} desvinculado deste bot.`,
          ctx,
        )
        if (result.success) notice(ctx, result.content?.find((part) => part.type === "text")?.text ?? "")
        return result
      },
    },
    {
      name: "folder_access_remove",
      group: "project",
      handler: async ({ ctx, args }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot pode alterar sua configuração.")
        const input = args as { path: string }
        // Stored canonical paths can be removed even after a folder disappears.
        let path = input.path
        if (!(bot.folders ?? []).some((folder) => folder.path === path)) {
          try {
            path = hostPath(path)
          } catch {
            return { success: false, errorCode: "NOT_FOUND", error: "Pasta não encontrada nas permissões deste bot." }
          }
        }
        if (!(bot.folders ?? []).some((folder) => folder.path === path))
          return { success: false, errorCode: "NOT_FOUND", error: "Pasta não encontrada nas permissões deste bot." }
        const result = await changed(
          bot,
          { folders: (bot.folders ?? []).filter((folder) => folder.path !== path) },
          `Acesso à pasta ${path} removido deste bot.`,
          ctx,
        )
        if (result.success) notice(ctx, result.content?.find((part) => part.type === "text")?.text ?? "")
        return result
      },
    },
  ]
}
