import { realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, parse } from "node:path"
import type { Bot, Kernel, ToolContext, ToolRegistration, ToolResult } from "@touri/contracts"
import { getDelegation } from "../groups/security"
import { excludedBotFolders, parseBotFolders, resolveBotFolder, withinFolder } from "../kernel/bot-folders"
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

const hostPath = (value: string): string => {
  const path = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path) || /[\0\n\r*]/.test(path)) throw new Error("Informe o caminho absoluto de uma pasta deste Mac.")
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error("O caminho precisa ser uma pasta.")
  if (canonical === parse(canonical).root)
    throw new Error("O acesso a qualquer pasta deste Mac é exclusivo dos ajustes.")
  return canonical
}

export const createSetupTools = ({
  kernel,
  store,
}: {
  kernel: Kernel
  store: ProjectStore
}): Array<ToolRegistration & { group: "project" }> => {
  const api = () => kernel.services.use("store.api")
  const self = (ctx: ToolContext): Bot | null => {
    const bot = api()?.getBot({ botId: ctx.botId })
    // A peer's delegated request cannot persist changes outside its ceiling.
    if (ctx.signal.aborted || getDelegation(kernel, ctx.threadId)) return null
    return bot && api()?.getThread({ threadId: ctx.threadId })?.botId === bot.id ? bot : null
  }
  const changed = (bot: Bot, patch: Partial<Pick<Bot, "projectId" | "folders">>, text: string) => {
    const configure = kernel.services.use("bots.configureAccess")
    if (!configure) return denied("A configuração do bot está indisponível.")
    const result = configure({ botId: bot.id, patch })
    if (!result.success) return result
    const message = bot.machine === "vm" ? `${text} A mudança entra em vigor no próximo turno da VM.` : text
    return {
      success: true as const,
      content: [{ type: "text" as const, text: message }],
      structured: { projectId: result.bot.projectId, folders: result.bot.folders, effective: "next-turn", message },
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
          const path = hostPath(source)
          const project = registered ?? store.getProjectByPath(path)
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
              name,
              projectId: project?.id ?? null,
              previousProject: previous ? { name: previous.name, path: previous.path } : null,
              nextTurn: bot.machine === "vm",
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
            const created = store.createProject({
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
          return changed(bot, { projectId: linked.id }, `Projeto ${name} (${path}) vinculado a este bot.`)
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
        if (bot.machine === "cloud") return denied("Pastas deste Mac não estão disponíveis na nuvem.")
        const input = args as { path: string; mode: "read" | "read-write" }
        try {
          const path = resolveBotFolder(hostPath(input.path))
          const access = input.mode === "read" ? "read-only" : "read-write"
          const folders = parseBotFolders([
            ...(bot.folders ?? []).filter((folder) => folder.path !== path),
            { path, access },
          ])
          const targetCurrent = () => {
            try {
              return resolveBotFolder(hostPath(input.path)) === path
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
              mode: input.mode,
              previousMode: bot.folders?.find((folder) => folder.path === path)?.access ?? null,
              nextTurn: bot.machine === "vm",
            },
            targetCurrent,
          )
          if (!authorized?.()) return denied("O acesso não foi aprovado ou a configuração mudou.")
          return changed(
            bot,
            { folders },
            `Acesso ${input.mode === "read" ? "de leitura" : "de leitura e escrita"} à pasta ${path} concedido a este bot.`,
          )
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
      name: "project_unlink",
      group: "project",
      handler: async ({ ctx }) => {
        const bot = self(ctx)
        if (!bot) return denied("Somente o próprio bot pode alterar sua configuração.")
        const project = bot.projectId ? store.getProject(bot.projectId) : null
        const result = changed(bot, { projectId: null }, `Projeto ${project?.name ?? "atual"} desvinculado deste bot.`)
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
        const result = changed(
          bot,
          { folders: (bot.folders ?? []).filter((folder) => folder.path !== path) },
          `Acesso à pasta ${path} removido deste bot.`,
        )
        if (result.success) notice(ctx, result.content?.find((part) => part.type === "text")?.text ?? "")
        return result
      },
    },
  ]
}
