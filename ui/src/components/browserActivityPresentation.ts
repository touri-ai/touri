import type { MessagePart, ToolCallPart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { type Locale, type ptBR, t } from "../i18n"
import { asToolRecord, parseToolValue, toolIdentity, toolLeaf } from "./toolPresentation"

const MAX_INPUT_LENGTH = 12_000
const MAX_OUTPUT_LENGTH = 16_000
const MAX_LABEL_LENGTH = 72

const browserAction = (part: ToolCallPart): string => toolLeaf(part.tool).replace(/^(browser|computer)_/, "")

const getArgs = (part: ToolCallPart): Record<string, unknown> | null => {
  if (part.inputJson.length > MAX_INPUT_LENGTH) return null

  return asToolRecord(parseToolValue(redactToolText(part.inputJson)))
}

const safeLabel = (value: unknown): string | null => {
  if (typeof value !== "string") return null

  const label = redactToolText(value)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)

  return label || null
}

const getTargetName = (args: Record<string, unknown> | null): string | null => {
  const target = asToolRecord(args?.target)

  return safeLabel(target?.name ?? target?.text)
}

const getOutputTabId = (part: ToolCallPart): string | undefined => {
  if (!part.outputJson || part.outputAttachmentId || part.outputJson.length > MAX_OUTPUT_LENGTH) return undefined
  const output = asToolRecord(parseToolValue(redactToolText(part.outputJson)))
  const structured = asToolRecord(output?.structured ?? output?.structuredContent)

  return typeof output?.tabId === "string"
    ? output.tabId
    : typeof structured?.tabId === "string"
      ? structured.tabId
      : undefined
}

export const getBrowserActivityTools = (parts: readonly MessagePart[]): ToolCallPart[] => [
  ...new Map(
    parts.flatMap((part) =>
      part.type === "tool_call" && toolIdentity(part.tool).kind === "browser" ? [[part.callId, part] as const] : [],
    ),
  ).values(),
]

export const getBrowserActivityTabId = (parts: readonly ToolCallPart[]): string | undefined =>
  [...parts]
    .reverse()
    .map((part) => getArgs(part)?.tabId)
    .find((value): value is string => typeof value === "string") ??
  [...parts]
    .reverse()
    .map(getOutputTabId)
    .find((value): value is string => typeof value === "string")

export const getBrowserActivityScreenshot = (parts: readonly ToolCallPart[]): ToolCallPart | undefined =>
  [...parts].reverse().find((part) => {
    const action = browserAction(part)

    return (action === "screenshot" || action === "take_screenshot") && Boolean(part.outputAttachmentId)
  })

export const getBrowserActivityLabel = (part: ToolCallPart, locale: Locale): string => {
  const action = browserAction(part)
  const target = getTargetName(getArgs(part))
  const targetArgs = target ? { target } : {}
  const labels: Record<string, keyof typeof ptBR> = {
    open: "Opened a page",
    navigate: "Opened a page",
    snapshot: "Read the page",
    click: target ? "Clicked {target}" : "Clicked an element",
    type: target ? "Filled {target}" : "Filled a field",
    fill_form: "Filled a form",
    select_option: target ? "Selected an option in {target}" : "Selected an option",
    set_checked: target ? "Updated {target}" : "Updated a choice",
    screenshot: "Took a screenshot",
    take_screenshot: "Took a screenshot",
    scroll: "Scrolled the page",
    hover: "Inspected an element",
    wait_for: "Waited for the page",
    request_takeover: "Asked you to take over",
    submit_secret: "Filled a saved credential",
    fill_secret: "Filled a saved credential",
    press: "Pressed a key",
  } satisfies Record<string, keyof typeof ptBR>
  const label = labels[action] ?? "Used the browser"

  return t(label, targetArgs, locale)
}

export const getBrowserActivityTime = (part: ToolCallPart, fallback: number, locale: Locale): string => {
  const timestamp = part.startedAt ?? part.resolvedAt ?? fallback
  const language = locale === "pt-BR" ? "pt-BR" : "en-US"

  return new Date(timestamp).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
}

export const getBrowserActivityUrl = (value: string): string => {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""

    return redactToolText(url.href).slice(0, 180)
  } catch {
    return ""
  }
}
