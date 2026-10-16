import type { ApprovalPart, MessagePart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { localizeToolText, t } from "../i18n"
import { routineSchedule } from "../routineSchedule"

export type ToolPart = Extract<MessagePart, { type: "tool_call" | "command" | "file_change" }>
export type ToolKind = "terminal" | "browser" | "computer" | "files" | "tool"
export type ToolStatus = "pending" | "running" | "completed" | "denied" | "error" | "closed"

export const asToolRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Providers send plain JSON, a tool-prefixed envelope, or JSON encoded inside a string. */
export const parseToolValue = (raw: string): unknown => {
  let value: unknown = raw
  for (let depth = 0; depth < 4 && typeof value === "string"; depth++) {
    const text = value.replace(/^[\w.-]+:\s*(?=[{["])/, "")
    try {
      value = JSON.parse(text)
    } catch {
      return text
    }
  }
  return value
}

export const toolLeaf = (name: string): string => name.split("__").at(-1) ?? name

export const toolIdentity = (name: string, server?: string) => {
  const leaf = toolLeaf(name)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const kind: ToolKind = /^(Bash|shell|terminal|exec_command)$/i.test(leaf)
    ? "terminal"
    : leaf.startsWith("browser_")
      ? "browser"
      : leaf.startsWith("computer_")
        ? "computer"
        : /^(file_change|Read|Write|Edit|MultiEdit)$/i.test(leaf)
          ? "files"
          : "tool"
  const fileNames: Record<string, string> = {
    read: "Ler arquivo",
    write: "Escrever arquivo",
    edit: "Editar arquivo",
    multiedit: "Editar arquivos",
  }
  const friendly = {
    terminal: "Terminal",
    browser: "Navegador",
    computer: "Computador",
    files: fileNames[leaf.toLowerCase()] ?? "Arquivos",
    tool: leaf,
  }
  return { kind, name: server ? `${server} · ${leaf}` : mcp ? `${mcp[1]} · ${mcp[2]}` : friendly[kind] }
}

const readableValue = (value: unknown, prefix = ""): string => {
  if (Array.isArray(value)) return value.map((item, index) => readableValue(item, `${prefix}[${index}]`)).join("\n")
  const record = asToolRecord(value)
  if (record)
    return Object.entries(record)
      .map(([key, item]) => readableValue(item, prefix ? `${prefix}.${key}` : key))
      .join("\n")
  const text = value === null ? "—" : String(value)
  return prefix ? `${prefix}: ${text}` : text
}

export const prettyToolValue = (value: unknown): string => readableValue(value) || "Sem parâmetros."

const safeValue = (raw: string): unknown => {
  const parsed = parseToolValue(raw)
  return parseToolValue(redactToolText(typeof parsed === "string" ? parsed : JSON.stringify(parsed)))
}

export const approvalToolName = (approval: ApprovalPart): string =>
  approval.scope?.tool ??
  /^[\w.-]+(?=:)/.exec(approval.detail)?.[0] ??
  (approval.request === "command" ? "Bash" : approval.request === "file_change" ? "file_change" : "Ferramenta")

const approvalDetail = (approval: ApprovalPart): string => {
  const prefix = `${approvalToolName(approval)}:`
  return approval.detail.startsWith(prefix) ? approval.detail.slice(prefix.length).trimStart() : approval.detail
}

const setupPresentation = (name: string, input: Record<string, unknown> | null) => {
  if (name.includes("__") && !name.startsWith("mcp__touri__")) return null
  const leaf = toolLeaf(name)
  const path = typeof input?.path === "string" ? input.path : ""
  if (
    ["routine_create", "project_link", "folder_access_request", "project_unlink", "folder_access_remove"].includes(
      leaf,
    ) &&
    (!input ||
      (leaf === "routine_create" &&
        ![input.name, input.cron, input.timezone].every((value) => typeof value === "string" && value.trim())))
  )
    return {
      name: t("Detalhes indisponíveis"),
      summary: t("Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente."),
      canApprove: false,
    }
  let title: string
  let summary: string
  let preview = ""
  let approvalLabel: string | undefined
  if (leaf === "routine_create") {
    title = input?.routineId ? t("Ativar rotina") : t("Criar cron")
    summary = `${String(input?.name ?? "")} · ${routineSchedule(String(input?.cron ?? ""), String(input?.timezone ?? ""))}`
    if (input?.routineId) approvalLabel = t("Ativar rotina “{name}”", { name: String(input.name) })
    const prompt = typeof input?.promptPreview === "string" ? input.promptPreview : input?.prompt
    if (typeof prompt === "string") {
      preview = `${t("Prévia da instrução")}\n${prompt}`
      const length = typeof input?.promptLength === "number" ? input.promptLength : prompt.length
      preview += `\n${t("Tamanho completo: {count} caracteres", { count: length })}`
    }
  } else if (leaf === "project_link") {
    title = t("Vincular projeto")
    summary = t("Vincular {name} ({path}) a este bot", {
      name: String(input?.name ?? path.split("/").filter(Boolean).at(-1) ?? input?.projectId ?? t("Projeto")),
      path,
    })
    const previous = asToolRecord(input?.previousProject)
    if (previous)
      summary += ` ${t("Substitui o projeto {name} ({path}).", { name: String(previous.name), path: String(previous.path) })}`
  } else if (leaf === "folder_access_request") {
    title = t("Conceder acesso à pasta")
    summary = t("Permitir {mode} em {path} para este bot", {
      mode: t(input?.mode === "read" ? "Somente leitura" : "Leitura e escrita"),
      path,
    })
    if (input?.previousMode)
      summary += ` ${t("Acesso anterior: {mode}.", { mode: t(input.previousMode === "read-only" ? "Somente leitura" : "Leitura e escrita") })}`
  } else if (leaf === "project_unlink") {
    title = t("Desvincular projeto")
    summary = t("Desvincular o projeto deste bot.")
  } else if (leaf === "folder_access_remove") {
    title = t("Remover acesso à pasta")
    summary = t("Remover o acesso deste bot a {path}.", { path })
  } else return null
  if (input?.nextTurn) summary += ` ${t("A mudança entra em vigor no próximo turno da VM.")}`
  return { name: title, summary, preview, approvalLabel, canApprove: true }
}

const projectToolPresentation = (name: string, input: Record<string, unknown> | null) => {
  if (name.includes("__") && !name.startsWith("mcp__touri__")) return null
  const process = typeof input?.name === "string" ? input.name : t("do projeto")
  const command = typeof input?.command === "string" ? `: ${input.command}` : ""
  const presentations: Record<string, { name: string; summary: string }> = {
    process_list: { name: t("Listar processos"), summary: t("Consultar os processos do projeto e seus estados") },
    process_define: {
      name: t("Definir processo"),
      summary: t("Definir o processo {name}{command}", { name: process, command }),
    },
    process_start: { name: t("Iniciar processo"), summary: t("Iniciar o processo {name}", { name: process }) },
    process_stop: { name: t("Parar processo"), summary: t("Parar o processo {name}", { name: process }) },
    process_restart: { name: t("Reiniciar processo"), summary: t("Reiniciar o processo {name}", { name: process }) },
    process_logs: { name: t("Ler logs"), summary: t("Consultar os logs do processo {name}", { name: process }) },
    preview_open: {
      name: t("Abrir prévia"),
      summary: t("Abrir a prévia do projeto em {path}", { path: typeof input?.path === "string" ? input.path : "/" }),
    },
  }
  return presentations[toolLeaf(name)] ?? null
}

export const toolPresentation = (part?: ToolPart, approval?: ApprovalPart) => {
  const name = part
    ? part.type === "tool_call"
      ? part.tool
      : part.type === "command"
        ? "Bash"
        : "file_change"
    : approval
      ? approvalToolName(approval)
      : "Ferramenta"
  const raw = part
    ? part.type === "tool_call"
      ? part.inputJson
      : part.type === "command"
        ? JSON.stringify({ command: part.command, cwd: part.cwd })
        : JSON.stringify({ paths: part.paths })
    : approval
      ? approvalDetail(approval)
      : ""
  const value = safeValue(raw)
  const args = asToolRecord(value)
  // An approval contains the reviewed, canonical target. Provider tool input may
  // contain only an ID or an alias and must not override that reviewed summary.
  const setup =
    !approval || approval.scope?.server === "touri"
      ? setupPresentation(
          approval ? approvalToolName(approval) : name,
          approval ? asToolRecord(safeValue(approvalDetail(approval))) : args,
        )
      : null
  const projectTool = !approval || approval.scope?.server === "touri" ? projectToolPresentation(name, args) : null
  const identity = toolIdentity(name, approval?.scope?.server)
  const description = typeof args?.description === "string" ? args.description : ""
  const summary = part?.type === "tool_call" && !/^Claude tool |^[{[]/.test(part.summary) ? part.summary : ""
  const defaults = {
    terminal: "Executar comando no terminal",
    browser: "Interagir com o navegador",
    computer: "Interagir com o computador",
    files: toolLeaf(name).toLowerCase() === "read" ? "Consultar o conteúdo do arquivo" : "Alterar arquivos do projeto",
    tool: "Executar ferramenta",
  }
  const command = args?.command ?? args?.cmd
  const pathValue = args?.file_path ?? args?.filePath ?? args?.path ?? args?.paths
  const filePaths =
    identity.kind === "files"
      ? (Array.isArray(pathValue) ? pathValue : [pathValue]).filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : []
  const parameters = args
    ? Object.fromEntries(
        Object.entries(args).filter(
          ([key]) =>
            key !== "description" && !(filePaths.length && ["file_path", "filePath", "path", "paths"].includes(key)),
        ),
      )
    : null
  return {
    ...identity,
    ...(setup ? { name: setup.name } : {}),
    canApprove: setup?.canApprove ?? true,
    approvalLabel: setup?.approvalLabel,
    ...(projectTool ? { name: projectTool.name } : {}),
    filePaths,
    summary:
      setup?.summary ??
      projectTool?.summary ??
      localizeToolText(
        description ||
          summary ||
          (typeof value === "string" && !/^[{[]/.test(value.trim()) && identity.kind !== "terminal"
            ? value
            : defaults[identity.kind]),
      ),
    code:
      setup && approval
        ? (setup.preview ?? "")
        : identity.kind === "terminal"
          ? typeof command === "string"
            ? command
            : Array.isArray(command)
              ? command.join(" ")
              : typeof value === "string" && !/^[{[]/.test(value.trim())
                ? value
                : "Comando indisponível. Abra os detalhes técnicos."
          : filePaths.length && parameters && Object.keys(parameters).length === 0
            ? ""
            : prettyToolValue(
                parameters
                  ? parameters
                  : typeof value === "string" && /^[{[]/.test(value.trim())
                    ? "Parâmetros incompletos. Abra os detalhes técnicos."
                    : value,
              ),
    technical: redactToolText(typeof value === "string" ? raw : JSON.stringify(value, null, 2)),
  }
}

export const toolStatus = (part?: ToolPart, finished = false): ToolStatus => {
  if (!part) return "closed"
  if (part.resolution === "succeeded") return "completed"
  if (part.resolution === "failed") return "error"
  if (part.resolution === "completed_unobserved") {
    if (part.type === "tool_call" && part.ok !== null) return part.ok ? "completed" : "error"
    if (part.type === "command" && part.exitCode !== null) return part.exitCode === 0 ? "completed" : "error"
    if (part.type === "file_change" && part.completedOutcome)
      return part.completedOutcome === "succeeded" ? "completed" : "error"
    return "closed"
  }
  if (part.resolution && part.resolution !== "running") return "closed"
  if (part.type === "tool_call" && part.ok !== null) return part.ok ? "completed" : "error"
  if (part.type === "command" && part.exitCode !== null) return part.exitCode === 0 ? "completed" : "error"
  return finished ? "closed" : "running"
}

const canonicalValue = (value: unknown): string => {
  const record = asToolRecord(value)
  if (record)
    return JSON.stringify(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    )
  return Array.isArray(value) ? JSON.stringify(value.map(canonicalValue)) : JSON.stringify(value)
}

/** No call ID exists on ApprovalPart. Match by tool + input, never by tool name alone. */
export const approvalMatchesTool = (approval: ApprovalPart, part: ToolPart): boolean => {
  const input = parseToolValue(approvalDetail(approval))
  const args = asToolRecord(input)
  if (part.type === "command") return (args?.command ?? input) === part.command && (!args?.cwd || args.cwd === part.cwd)
  if (part.type === "file_change")
    return approval.request === "file_change" && canonicalValue(args?.paths) === canonicalValue(part.paths)
  const name = approvalToolName(approval)
  if (toolLeaf(name) !== toolLeaf(part.tool)) return false
  const mcpServer = /^mcp__(.+?)__/.exec(part.tool)?.[1]
  if (approval.scope?.server && mcpServer && approval.scope.server !== mcpServer) return false
  // Setup cards retain the original spelling for matching and the canonical
  // path for presentation. Enrichment must not split one operation into two cards.
  if (approval.scope?.source === "mcp" && approval.scope.server === "touri" && mcpServer === "touri") {
    const original = asToolRecord(parseToolValue(part.inputJson))
    const target = args?.requestedPath ?? args?.path
    if (toolLeaf(name) === "project_link") {
      if (typeof original?.projectId === "string") return original.projectId === args?.projectId
      if (typeof original?.path === "string") return original.path === target
    }
    if (toolLeaf(name) === "folder_access_request")
      return typeof original?.path === "string" && original.path === target && original.mode === args?.mode
  }
  return canonicalValue(input) === canonicalValue(parseToolValue(part.inputJson))
}
