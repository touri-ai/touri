import type { ApprovalPart } from "./types"

type Locale = "pt-BR" | "en"
type Approval = Pick<ApprovalPart, "request" | "detail" | "scope">

const copy = {
  "Ativar navegador": "Enable browser",
  "Ativar controle do computador": "Enable computer control",
  "{bot} quer ativar o navegador dele para {reason}.": "{bot} wants to enable its browser to {reason}.",
  "{bot} quer ativar o controle do computador para {reason}.": "{bot} wants to enable computer control to {reason}.",
  "Abre páginas no navegador isolado deste bot.": "Opens pages in this bot's isolated browser.",
  "Pode ver a tela e clicar ou digitar, somente onde o touri permite.":
    "Can see the screen and click or type, only where touri allows.",
  "Controla somente a tela do computador isolado do bot.": "Controls only the bot's isolated computer screen.",
  "Controla a tela deste computador, com as permissões do touri.":
    "Controls this computer's screen, subject to touri permissions.",
  "A configuração fica salva neste bot. Você pode desativar nos ajustes.":
    "The setting is saved for this bot. You can turn it off in settings.",
  "Após ativar, o touri retoma a tarefa automaticamente.": "After enabling, touri resumes the task automatically.",
  Terminal: "Terminal",
  Arquivos: "Files",
  Ferramenta: "Tool",
  Navegador: "Browser",
  Computador: "Computer",
  "Executar comando no terminal": "Run a terminal command",
  "Alterar arquivos do projeto": "Change project files",
  "Consultar o conteúdo do arquivo": "Read the file contents",
  "Executar ferramenta": "Run a tool",
  "Interagir com o navegador": "Interact with the browser",
  "Interagir com o computador": "Interact with the computer",
  "Conceder acesso à pasta": "Grant folder access",
  "Permitir escrita em {path}?": "Allow writing in {path}?",
  "Após aprovar, a pasta {path} será criada automaticamente.":
    "After approval, the folder {path} will be created automatically.",
  "Somente leitura": "Read-only",
  "Leitura e escrita": "Read and write",
  "Permitir {mode} em {path} para este bot.": "Allow {mode} in {path} for this bot.",
  "Acesso anterior: {mode}.": "Previous access: {mode}.",
  "Vale a partir da próxima mensagem na VM.": "Takes effect from the next message in the VM.",
  "Vale a partir da próxima mensagem.": "Takes effect from the next message.",
  "Detalhes indisponíveis": "Details unavailable",
  "Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente.":
    "The details of this action could not be shown. Deny it and ask the bot to request it again.",
} as const

const text = (key: keyof typeof copy, locale: Locale, params: Record<string, string> = {}): string =>
  (locale === "en" ? copy[key] : key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? "")

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const inputValue = (detail: string): Record<string, unknown> | null => {
  let value: unknown = detail
  for (let depth = 0; depth < 4 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value.replace(/^[\w.-]+:\s*(?=[{["])/, ""))
    } catch {
      return null
    }
  }
  return record(value)
}

/** Notification copy never echoes provider descriptions, commands, tool names or JSON. */
export const approvalSummary = (approval: Approval, locale: Locale = "pt-BR"): { title: string; body: string } => {
  const name = approval.scope?.tool ?? /^[\w.-]+(?=:)/.exec(approval.detail)?.[0] ?? ""
  const leaf = name.split("__").at(-1) ?? name
  const ownTool = approval.scope
    ? approval.scope.server === "touri"
    : !name.includes("__") || name.startsWith("mcp__touri__")
  if (ownTool && leaf === "team_create")
    return locale === "en"
      ? {
          title: "Create team",
          body: "Review each bot, provider and safe access before creating the team. Cancel creates nothing.",
        }
      : {
          title: "Criar time",
          body: "Revise cada bot, provedor e acesso seguro antes de criar o time. Cancelar não cria nada.",
        }
  if (ownTool && leaf === "capability_request") {
    const input = inputValue(approval.detail)
    if (
      !["browser", "computer_use"].includes(String(input?.capability)) ||
      ![input?.botName, input?.reason].every(
        (value) => typeof value === "string" && value.trim() && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value),
      ) ||
      !["local", "vm"].includes(String(input?.machine)) ||
      typeof input?.hostComputerUse !== "boolean"
    )
      return {
        title: text("Detalhes indisponíveis", locale),
        body: text(
          "Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente.",
          locale,
        ),
      }
    const browser = input?.capability === "browser"
    const body = [
      text(
        browser
          ? "{bot} quer ativar o navegador dele para {reason}."
          : "{bot} quer ativar o controle do computador para {reason}.",
        locale,
        { bot: String(input?.botName), reason: String(input?.reason) },
      ),
      text(
        browser
          ? "Abre páginas no navegador isolado deste bot."
          : "Pode ver a tela e clicar ou digitar, somente onde o touri permite.",
        locale,
      ),
      ...(!browser
        ? [
            text(
              input?.machine === "vm" && !input.hostComputerUse
                ? "Controla somente a tela do computador isolado do bot."
                : "Controla a tela deste computador, com as permissões do touri.",
              locale,
            ),
          ]
        : []),
      text("A configuração fica salva neste bot. Você pode desativar nos ajustes.", locale),
      text("Após ativar, o touri retoma a tarefa automaticamente.", locale),
    ].join(" ")
    return { title: text(browser ? "Ativar navegador" : "Ativar controle do computador", locale), body }
  }
  if (ownTool && leaf === "folder_access_request") {
    const input = inputValue(approval.detail)
    if (
      typeof input?.path !== "string" ||
      !input.path.startsWith("/") ||
      /[\r\n\0]/.test(input.path) ||
      !["read", "read-write"].includes(String(input.mode))
    )
      return {
        title: text("Detalhes indisponíveis", locale),
        body: text(
          "Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente.",
          locale,
        ),
      }
    let body = text("Permitir {mode} em {path} para este bot.", locale, {
      mode: text(input.mode === "read" ? "Somente leitura" : "Leitura e escrita", locale),
      path: input.path,
    })
    if (input.previousMode)
      body += ` ${text("Acesso anterior: {mode}.", locale, {
        mode: text(input.previousMode === "read-only" ? "Somente leitura" : "Leitura e escrita", locale),
      })}`
    if (input.nextTurn)
      body += ` ${text(
        input.machine === "local" ? "Vale a partir da próxima mensagem." : "Vale a partir da próxima mensagem na VM.",
        locale,
      )}`
    if (typeof input.createPath === "string")
      body += ` ${text("Após aprovar, a pasta {path} será criada automaticamente.", locale, { path: input.createPath })}`
    return {
      title: input.writeApproval
        ? text("Permitir escrita em {path}?", locale, { path: input.path })
        : text("Conceder acesso à pasta", locale),
      body,
    }
  }
  const [title, body]: [keyof typeof copy, keyof typeof copy] =
    approval.request === "command" || /^(Bash|shell|terminal|exec_command)$/i.test(leaf)
      ? ["Terminal", "Executar comando no terminal"]
      : /^Read$/i.test(leaf)
        ? ["Arquivos", "Consultar o conteúdo do arquivo"]
        : approval.request === "file_change" || /^(file_change|Write|Edit|MultiEdit)$/i.test(leaf)
          ? ["Arquivos", "Alterar arquivos do projeto"]
          : leaf.startsWith("browser_")
            ? ["Navegador", "Interagir com o navegador"]
            : leaf.startsWith("computer_")
              ? ["Computador", "Interagir com o computador"]
              : ["Ferramenta", "Executar ferramenta"]
  return { title: text(title, locale), body: text(body, locale) }
}

export const isApprovalNoticeTitle = (title: string): boolean =>
  /(?:^|: )Approve (?:action|command|file change)$/.test(title) ||
  /(?:^|: )(?:Permitir escrita em|Allow writing in) \/[^\r\n]*\?$/.test(title) ||
  (
    [
      "Ativar navegador",
      "Ativar controle do computador",
      "Terminal",
      "Arquivos",
      "Ferramenta",
      "Navegador",
      "Computador",
      "Conceder acesso à pasta",
      "Detalhes indisponíveis",
    ] as const
  ).some((key) => [key, copy[key]].some((label) => title === label || title.endsWith(`: ${label}`)))
