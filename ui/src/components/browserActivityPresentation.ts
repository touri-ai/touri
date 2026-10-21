import type { MessagePart, ToolCallPart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { type Locale, type ptBR, t } from "../i18n"
import { asToolRecord, parseToolValue, toolIdentity, toolLeaf } from "./toolPresentation"

const MAX_INPUT_LENGTH = 12_000
const MAX_OUTPUT_LENGTH = 16_000

const getBrowserAction = (part: ToolCallPart): string =>
  toolLeaf(part.tool)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^(browser|computer)_/, "")

const getArgs = (part: ToolCallPart): Record<string, unknown> | null => {
  if (part.inputJson.length > MAX_INPUT_LENGTH) return null

  return asToolRecord(parseToolValue(redactToolText(part.inputJson)))
}

const getOutputTabId = (part: ToolCallPart): string | undefined => {
  if (!part.outputJson || part.outputAttachmentId || part.outputJson.length > MAX_OUTPUT_LENGTH) return undefined
  const output = asToolRecord(parseToolValue(redactToolText(part.outputJson)))
  const structured = asToolRecord(output?.structured ?? output?.structuredContent)

  if (typeof output?.tabId === "string") return output.tabId

  return typeof structured?.tabId === "string" ? structured.tabId : undefined
}

export const getBrowserActivityTools = (parts: readonly MessagePart[]): ToolCallPart[] => [
  ...new Map(
    parts.flatMap((part) =>
      part.type === "tool_call" && toolIdentity(part.tool).kind === "browser" ? [[part.callId, part] as const] : [],
    ),
  ).values(),
]

export const getBrowserActivityTabId = (parts: readonly ToolCallPart[]): string | undefined => {
  const latest = parts.reduceRight<ToolCallPart | undefined>((latest, part) => {
    if (latest) return latest
    if (getBrowserAction(part) === "open") return part

    return typeof (getOutputTabId(part) ?? getArgs(part)?.tabId) === "string" ? part : undefined
  }, undefined)
  if (!latest) return undefined
  const tabId = getOutputTabId(latest) ?? getArgs(latest)?.tabId

  return typeof tabId === "string" ? tabId : undefined
}

export const getBrowserActivityScreenshot = (parts: readonly ToolCallPart[]): ToolCallPart | undefined =>
  parts.reduceRight<ToolCallPart | undefined>((screenshot, part) => {
    if (screenshot) return screenshot
    const action = getBrowserAction(part)

    const hasImage =
      part.ok === true && (action === "screenshot" || action === "take_screenshot") && Boolean(part.outputAttachmentId)

    return hasImage ? part : undefined
  }, undefined)

const MAX_TARGET_LENGTH = 32

/** Only the visible name of the element, never typed values; it is redacted and shortened before display. */
export const getBrowserActivityTarget = (part: ToolCallPart): string => {
  if (!["click", "select_option"].includes(getBrowserAction(part))) return ""
  const target = asToolRecord(getArgs(part)?.target)
  const name = typeof target?.name === "string" ? redactToolText(target.name).replace(/\s+/g, " ").trim() : ""
  if (!name || name.includes("[REDACTED") || name.includes("@")) return ""

  return name.length > MAX_TARGET_LENGTH ? `${name.slice(0, MAX_TARGET_LENGTH - 1)}…` : name
}

export const getBrowserActivityLabel = (part: ToolCallPart, locale: Locale): string => {
  if (part.ok === false) return t("Browser action failed. Take over to continue.", {}, locale)

  const action = getBrowserAction(part)
  const target = getBrowserActivityTarget(part)
  if (target && action === "click") return t("Clicked {target}", { target }, locale)
  const labels: Record<string, keyof typeof ptBR> = {
    open: "Opened a page",
    navigate: "Opened a page",
    snapshot: "Read the page",
    click: "Clicked",
    type: "Filled a field",
    fill: "Filled a field",
    fill_form: "Filled a form",
    select_option: "Selected an option",
    set_checked: "Updated a choice",
    screenshot: "Took a screenshot",
    take_screenshot: "Took a screenshot",
    scroll: "Scrolled the page",
    hover: "Inspected an element",
    wait_for: "Waited for the page",
    request_takeover: "Asked you to take over",
    submit_secret: "Filled a saved credential",
    fill_secret: "Filled a saved credential",
    press: "Pressed a key",
    list_tabs: "Moved between tabs",
    switch_tab: "Moved between tabs",
  } satisfies Record<string, keyof typeof ptBR>
  const label = labels[action] ?? "Used the browser"

  return t(label, {}, locale)
}

export const isBrowserActivityRunning = (part: ToolCallPart): boolean => part.ok === null || part.ok === undefined

/** Lowercase gerund for the live subtitle, e.g. "preenchendo um campo". */
export const getBrowserActivitySubtitleAction = (part: ToolCallPart, locale: Locale): string =>
  getBrowserActivityCurrentLabel(part, locale).replace(/^./u, (first) => first.toLocaleLowerCase(locale))

export const getBrowserActivityCurrentLabel = (part: ToolCallPart, locale: Locale): string => {
  if (!isBrowserActivityRunning(part)) return getBrowserActivityLabel(part, locale)

  const action = getBrowserAction(part)
  const labels: Record<string, keyof typeof ptBR> = {
    open: "Opening a page",
    navigate: "Opening a page",
    snapshot: "Reading the page",
    click: "Clicking",
    type: "Filling a field",
    fill: "Filling a field",
    fill_form: "Filling a form",
    select_option: "Selecting an option",
    screenshot: "Taking a screenshot",
    take_screenshot: "Taking a screenshot",
    scroll: "Moving on the page",
    hover: "Inspecting an element",
    wait_for: "Waiting for the page",
    list_tabs: "Moving between tabs",
    switch_tab: "Moving between tabs",
  } satisfies Record<string, keyof typeof ptBR>

  return t(labels[action] ?? "Browser action in progress…", {}, locale)
}

export const getBrowserActivityKind = (part: ToolCallPart): string => {
  const action = getBrowserAction(part)
  if (["open", "navigate"].includes(action)) return "open"
  if (["snapshot", "wait_for"].includes(action)) return "read"
  if (action === "click") return "click"
  if (["type", "fill", "fill_form", "select_option", "set_checked", "fill_secret", "submit_secret"].includes(action))
    return "fill"
  if (["screenshot", "take_screenshot"].includes(action)) return "screenshot"
  if (["list_tabs", "switch_tab"].includes(action)) return "tabs"
  return "other"
}

export const getBrowserActivityNotice = (part: ToolCallPart, locale: Locale): string | null => {
  const output = part.outputJson?.slice(0, MAX_OUTPUT_LENGTH) ?? ""
  if (output.includes("TOURI_BROWSER_TAKEOVER_REQUIRED|"))
    return t("This action needs you. Take over the tab to continue.", {}, locale)
  if (output.includes("TOURI_BROWSER_DECISION_QUESTION|"))
    return t("Could not choose safely. Take over the tab to choose.", {}, locale)

  const notices = {
    missing_key:
      "Assisted browser choices are off or have no saved key. You can enable them in API model settings. The browser will keep working.",
    no_credit: "The browser helper has no credit. Continuing with standard controls.",
    unavailable: "The browser helper is unavailable. Continuing with standard controls.",
    invalid_response: "The browser helper is unavailable. Continuing with standard controls.",
  } as const
  const reason = /TOURI_BROWSER_DECISION_HINT\|(missing_key|no_credit|unavailable|invalid_response)\b/.exec(output)?.[1]
  if (!reason || !Object.hasOwn(notices, reason)) return null

  return t(notices[reason as keyof typeof notices], {}, locale)
}

/** One timestamp per action from the same source (start time first), never later than the next action. */
export const getBrowserActivityTimestamps = (parts: readonly ToolCallPart[], fallback: number): number[] => {
  const times = parts.map((part) => part.startedAt ?? part.resolvedAt ?? fallback)

  return times.map((_, index) => Math.min(...times.slice(index)))
}

export const getBrowserActivityTime = (timestamp: number, locale: Locale): string => {
  const language = locale === "pt-BR" ? "pt-BR" : "en-US"

  return new Date(timestamp).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
}

export const getBrowserActivityUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return ""

    return redactToolText(`${url.origin}${url.pathname}`).slice(0, 180)
  } catch {
    return ""
  }
}

const MAX_SUBTITLE_PATH = 24

/** "host/short-path" for the header: no scheme, port, query, credentials or long paths. */
export const getBrowserActivityShortUrl = (value: string): string => {
  try {
    const url = new URL(getBrowserActivityUrl(value))
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")
    const shortPath = path.length > MAX_SUBTITLE_PATH ? `${path.slice(0, MAX_SUBTITLE_PATH - 1)}…` : path

    return `${url.hostname}${shortPath}`
  } catch {
    return ""
  }
}

export const getBrowserActivityOpenUrl = (parts: readonly ToolCallPart[]): string => {
  const open = parts.reduceRight<ToolCallPart | undefined>(
    (latest, part) => latest ?? (["open", "navigate"].includes(getBrowserAction(part)) ? part : undefined),
    undefined,
  )
  const args = open ? getArgs(open) : null

  return typeof args?.url === "string" ? getBrowserActivityUrl(args.url) : ""
}
