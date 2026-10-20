import type { ToolCallPart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { t } from "../i18n"
import { asToolRecord, parseToolValue, prettyToolValue, toolIdentity, toolLeaf } from "./toolPresentation"

const names: Record<string, string> = {
  open: "Abrir página",
  navigate: "Abrir página",
  click: "Clicar",
  type: "Digitar",
  fill_form: "Preencher formulário",
  snapshot: "Ler página",
  screenshot: "Captura",
  take_screenshot: "Captura",
  list_tabs: "Listar abas",
  tabs: "Listar abas",
  close_tab: "Fechar aba",
  close: "Fechar aba",
  press: "Pressionar tecla",
  press_key: "Pressionar tecla",
  scroll: "Rolar página",
  hover: "Passar o mouse",
  wait_for: "Aguardar página",
  evaluate: "Executar na página",
  select_option: "Selecionar opção",
  set_checked: "Marcar opção",
  fill_secret: "Preencher credencial",
  submit_secret: "Preencher credencial",
  request_takeover: "Pedir controle ao usuário",
  upload_files: "Enviar arquivos",
}

const clip = (value: string, limit = 120): string => (value.length > limit ? `${value.slice(0, limit)}…` : value)

const describeTarget = (value: unknown): string | null => {
  if (typeof value === "string") return `elemento ${value}`
  const target = asToolRecord(value)
  if (!target) return null
  if (target.kind === "role" || typeof target.role === "string")
    return `${String(target.role ?? "elemento")}${typeof target.name === "string" ? ` "${clip(target.name, 60)}"` : ""}`
  if (typeof target.text === "string") return `texto "${clip(target.text, 60)}"`
  if (typeof target.selector === "string") return `seletor ${clip(target.selector, 60)}`
  if (target.kind === "point") return `ponto (${String(target.x)}, ${String(target.y)})`
  if (typeof target.ref === "string") return `elemento ${target.ref}`
  return null
}

const describeCondition = (value: unknown): string | null => {
  const condition = asToolRecord(value)
  if (!condition) return null
  if (typeof condition.text === "string") return `texto "${clip(condition.text, 60)}"`
  if (typeof condition.url === "string") return `endereço com ${clip(condition.url, 60)}`
  if (typeof condition.state === "string") return `estado ${condition.state}`
  return describeTarget(condition.target)
}

const NAVIGATE_ACTIONS: Record<string, string> = { back: "Voltar", forward: "Avançar", reload: "Recarregar" }

/** One pt-BR clause saying what the browser tool is doing, without echoing secrets. */
export const browserActionDetail = ({
  action,
  args,
}: {
  action: string
  args: Record<string, unknown> | null
}): string | null => {
  if (!args) return null
  if (action === "navigate" && typeof args.action === "string" && NAVIGATE_ACTIONS[args.action])
    return NAVIGATE_ACTIONS[args.action] ?? null
  if (typeof args.url === "string") return clip(args.url, 180)
  if (action === "type") {
    const where = describeTarget(args.target)
    return typeof args.text === "string"
      ? `${clip(args.text, 60)}${where ? ` em ${where}` : ""}${args.submit === true ? " e Enter" : ""}`
      : where
  }
  if (action === "scroll")
    return args.target ? describeTarget(args.target) : args.direction === "up" ? "para cima" : "para baixo"
  if (action === "wait_for") return describeCondition(args.condition)
  if (action === "request_takeover") return typeof args.reason === "string" ? clip(args.reason, 140) : null
  if (action === "evaluate") return typeof args.expression === "string" ? clip(args.expression, 80) : null
  if (action === "select_option")
    return Array.isArray(args.values) ? `${args.values.join(", ")} em ${describeTarget(args.target) ?? "lista"}` : null
  if (action === "set_checked")
    return `${args.checked === true ? "marcar" : "desmarcar"} ${describeTarget(args.target) ?? ""}`.trim()
  if (action === "submit_secret") return "usuário e senha pelo cofre (valores não exibidos)"
  if (typeof args.selector === "string") return clip(args.selector, 180)
  if (typeof args.text === "string") return clip(args.text, 180)
  if (typeof args.key === "string") return args.key
  return describeTarget(args.target)
}

const ERROR_LINE = /ERROR\s+([A-Z_]+):\s*([^\n]+)/

const decisionHintKeys = {
  missing_key:
    "Assisted browser choices are off or have no saved key. You can enable them in API model settings. The browser will keep working.",
  no_credit:
    "The browser decision service has no credit. touri kept using its current browser behavior. Check the page before continuing.",
  unavailable: "The browser decision service could not connect. touri kept using its current browser behavior.",
  invalid_response:
    "The browser decision service returned an invalid answer. touri kept using its current browser behavior.",
} as const

const getDecisionMessage = (raw: string): string | null => {
  if (/TOURI_BROWSER_TAKEOVER_REQUIRED\|[a-z_]+/.test(raw))
    return t("This browser action needs your confirmation. Take over the tab to complete it.")

  const fallback = /TOURI_BROWSER_DECISION_HINT\|(missing_key|no_credit|unavailable|invalid_response)/.exec(raw)
  if (fallback?.[1] && Object.hasOwn(decisionHintKeys, fallback[1]))
    return t(decisionHintKeys[fallback[1] as keyof typeof decisionHintKeys])

  const question = /TOURI_BROWSER_DECISION_QUESTION\|([^\n]+)/.exec(raw)
  if (!question?.[1]) return null
  try {
    const value = asToolRecord(JSON.parse(question[1]))
    const choices = typeof value?.choices === "string" ? value.choices.slice(0, 600) : ""
    if (!choices) return t("The browser could not choose a target safely. Choose an option in chat before continuing.")

    return t("I couldn't choose safely. Which option should I use? {choices}", { choices })
  } catch {
    return t("The browser could not choose a target safely. Choose an option in chat before continuing.")
  }
}

const getBrowserOutputText = (raw: string): string => {
  if (raw.length > 64 * 1024) return raw.slice(0, 64 * 1024)

  // A local visit budget bounds malformed, deeply nested tool envelopes during rendering.
  let remaining = 64
  const getTexts = (value: unknown, depth = 0): string[] => {
    if (remaining-- <= 0 || depth > 6 || value == null) return []
    if (Array.isArray(value)) return value.slice(0, 64).flatMap((item) => getTexts(item, depth + 1))
    const record = asToolRecord(value)
    if (!record) return []
    if (record.type === "text" && typeof record.text === "string") return [record.text]

    return Array.isArray(record.content) ? getTexts(record.content, depth + 1) : []
  }
  try {
    const texts = getTexts(JSON.parse(raw))
    return texts.length ? texts.join("\n") : raw
  } catch {
    return raw
  }
}

/** Failure cause from an MCP browser result, in the words the engine used. */
export const browserFailureCause = (raw: string | null): string | null => {
  if (!raw) return null
  const text = redactToolText(getBrowserOutputText(raw)).replace(/\\n/g, "\n")
  const direct = ERROR_LINE.exec(text)
  const decisionMessage = getDecisionMessage(text)
  if (/TOURI_BROWSER_TAKEOVER_REQUIRED\|[a-z_]+/.test(text)) return decisionMessage
  if (decisionMessage) return clip(decisionMessage, 200)
  if (direct?.[2]) return clip(direct[2].replace(/\\"|"\}.*$/g, "").trim(), 160)
  const parsed = asToolRecord(parseToolValue(text))
  return typeof parsed?.error === "string" ? clip(parsed.error, 160) : null
}
export const browserToolPresentation = (part?: ToolCallPart) => {
  if (!part || toolIdentity(part.tool).kind !== "browser") return null
  const value = parseToolValue(redactToolText(part.inputJson))
  const args = asToolRecord(value)
  const action = toolLeaf(part.tool).replace(/^(browser|computer)_/, "")
  const name = names[action] ?? (toolIdentity(part.tool).kind === "browser" ? "Usar navegador" : "Usar computador")
  const safeArgs = args
    ? Object.fromEntries(Object.entries(args).filter(([, value]) => value != null && value !== ""))
    : null
  const labels: Record<string, string> = {
    url: "URL",
    selector: "Seletor",
    text: "Texto",
    target: "Alvo",
    tabId: "Aba",
    key: "Tecla",
    ref: "Referência",
    element: "Elemento",
  }
  const detail = browserActionDetail({ action, args: safeArgs })
  const cause = part.ok === false ? browserFailureCause(part.outputJson) : null
  const headline = detail ? `${name} · ${detail}` : name
  return {
    name,
    summary: cause ? `${headline} — falhou: ${cause}` : headline,
    code:
      safeArgs && Object.keys(safeArgs).length
        ? prettyToolValue(
            Object.fromEntries(Object.entries(safeArgs).map(([key, value]) => [labels[key] ?? key, value])),
          )
        : typeof value === "string" && /^[{[]/.test(value)
          ? "Parâmetros incompletos. Abra os detalhes técnicos."
          : "",
    technical:
      safeArgs && Object.keys(safeArgs).length
        ? JSON.stringify(safeArgs, null, 2)
        : typeof value === "string" && value.trim()
          ? redactToolText(part.inputJson)
          : "",
  }
}

/** Keep page context and screenshots without exposing base64 or empty MCP envelopes. */
export const browserToolResult = (raw: string | null): { title: string; url: string; output: string | null } => {
  const texts: unknown[] = []
  const images: unknown[] = []
  let title = ""
  let url = ""
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || value == null) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = asToolRecord(value)
    if (!record) {
      if (typeof value === "string" && value.trim()) texts.push({ type: "text", text: redactToolText(value) })
      return
    }
    if (record.type === "image") {
      images.push(record)
      return
    }
    if (record.type === "text" && typeof record.text === "string") {
      const decisionMessage = getDecisionMessage(redactToolText(record.text).replace(/\\n/g, "\n"))
      if (decisionMessage) {
        texts.push({ type: "text", text: decisionMessage })
        return
      }
      visit(parseToolValue(record.text), depth + 1)
      return
    }
    if (typeof record.title === "string") title = redactToolText(record.title)
    if (typeof record.url === "string") url = redactToolText(record.url)
    if (record.content || record.structured || record.structuredContent) {
      visit(record.structured ?? record.structuredContent, depth + 1)
      visit(record.content, depth + 1)
      return
    }
    if (record.image) visit(record.image, depth + 1)
    if (typeof record.dataUrl === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(record.dataUrl)) {
      const mimeType = record.dataUrl.slice(5, record.dataUrl.indexOf(";"))
      images.push({ type: "image", mimeType, data: record.dataUrl })
    }
    const useful = Object.fromEntries(
      Object.entries(record).filter(
        ([key, value]) =>
          !["image", "dataUrl", "title", "url"].includes(key) &&
          value != null &&
          value !== "" &&
          !(Array.isArray(value) && !value.length),
      ),
    )
    if (Object.keys(useful).length) texts.push({ type: "text", text: redactToolText(JSON.stringify(useful)) })
  }
  if (raw) visit(parseToolValue(raw))
  return {
    title,
    url,
    output: images.length || texts.length ? JSON.stringify({ content: [...images, ...texts] }) : null,
  }
}
