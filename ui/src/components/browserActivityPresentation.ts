import type { MessagePart, ToolCallPart } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { type Locale, type ptBR, t } from "../i18n"
import { asToolRecord, parseToolValue, toolIdentity, toolLeaf } from "./toolPresentation"

const MAX_INPUT_LENGTH = 12_000
const MAX_OUTPUT_LENGTH = 16_000
const MAX_LABEL_LENGTH = 72
const MAX_TARGET_LENGTH = 32

const getBrowserAction = (part: ToolCallPart): string =>
  toolLeaf(part.tool)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^(browser|computer)_/, "")

export const getBrowserActivityIcon = (part: ToolCallPart): string => {
  const icons: Record<string, string> = {
    open: "↗",
    navigate: "↗",
    snapshot: "◉",
    click: "⌖",
    type: "T",
    fill_form: "T",
    select_option: "⌄",
    set_checked: "✓",
    screenshot: "▧",
    take_screenshot: "▧",
    scroll: "↕",
    hover: "⌖",
    wait_for: "◷",
    request_takeover: "◷",
    submit_secret: "▤",
    fill_secret: "▤",
    press: "⌨",
  }
  return icons[getBrowserAction(part)] ?? "•"
}

const getArgs = (part: ToolCallPart): Record<string, unknown> | null => {
  if (part.inputJson.length > MAX_INPUT_LENGTH) return null

  return asToolRecord(parseToolValue(redactToolText(part.inputJson)))
}

const getSafeLabel = (value: unknown): string | null => {
  if (typeof value !== "string") return null

  const label = redactToolText(value)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH)

  return label || null
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

export const isBrowserRequestQueued = (parts: readonly ToolCallPart[], runId?: string | null): boolean => {
  const output = parts.at(-1)?.outputJson
  const parsed = asToolRecord(parseToolValue(output?.slice(0, MAX_OUTPUT_LENGTH) ?? ""))
  const structured = asToolRecord(parsed?.structured ?? parsed?.structuredContent ?? parsed)
  if (structured?.status !== "waiting_for_browser") return false

  return !runId || structured.requestRunId === runId
}

export const hasBrowserTakeoverRequest = (parts: readonly ToolCallPart[]): boolean =>
  parts.some(
    (part) =>
      getBrowserAction(part) === "request_takeover" || part.outputJson?.includes('"waiting_for_person"') === true,
  )

export const isBrowserActivityOpening = (parts: readonly ToolCallPart[]): boolean =>
  parts.some(
    (part) =>
      getBrowserAction(part) === "open" &&
      isBrowserActivityRunning(part) &&
      typeof (getOutputTabId(part) ?? getArgs(part)?.tabId) !== "string",
  )

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

export const getBrowserTakeoverReason = (parts: readonly ToolCallPart[]): string | null => {
  const takeover = parts.reduceRight<ToolCallPart | undefined>((latest, part) => {
    if (latest || getBrowserAction(part) !== "request_takeover") return latest
    return part
  }, undefined)
  return takeover ? getSafeLabel(getArgs(takeover)?.reason) : null
}

/** Only expose a short, redacted target name for actions that point to a visible element. */
export const getBrowserActivityTarget = (part: ToolCallPart): string => {
  if (!["click", "select_option"].includes(getBrowserAction(part))) return ""
  const target = asToolRecord(getArgs(part)?.target)
  const name = typeof target?.name === "string" ? redactToolText(target.name).replace(/\s+/g, " ").trim() : ""
  if (!name || name.includes("[REDACTED") || name.includes("@")) return ""

  return name.length > MAX_TARGET_LENGTH ? `${name.slice(0, MAX_TARGET_LENGTH - 1)}…` : name
}

export const getBrowserActivityLabel = (part: ToolCallPart, locale: Locale): string => {
  if (isBrowserRequestQueued([part])) return t("Waiting for the other browser request to finish.", {}, locale)
  if (part.ok === false) {
    const output = asToolRecord(parseToolValue(part.outputJson?.slice(0, MAX_OUTPUT_LENGTH) ?? ""))
    const code = output?.errorCode ?? asToolRecord(output?.structured)?.errorCode
    if (["TARGET_CHANGED", "STALE_REF", "NAVIGATED_DURING_SNAPSHOT"].includes(String(code)))
      return t("The page changed. Trying again.", {}, locale)
    if (["ENGINE_UNAVAILABLE", "DEADLINE_EXCEEDED", "CLIENT_DISCONNECTED"].includes(String(code)))
      return t("The browser could not connect. Reconnect and try again.", {}, locale)

    return t("The browser action did not finish. Checking the page.", {}, locale)
  }

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

export const getBrowserActivityCurrentLabel = (part: ToolCallPart, locale: Locale): string => {
  if (part.ok !== null && part.ok !== undefined) return getBrowserActivityLabel(part, locale)

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

export const isBrowserActivityRunning = (part: ToolCallPart): boolean => part.ok === null || part.ok === undefined

/** Lowercase live action text for the browser subtitle. */
export const getBrowserActivitySubtitleAction = (part: ToolCallPart, locale: Locale): string =>
  getBrowserActivityCurrentLabel(part, locale).replace(/^./u, (first) => first.toLocaleLowerCase(locale))

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
  const outputValue = asToolRecord(parseToolValue(redactToolText(output)))
  const structured = asToolRecord(outputValue?.structured ?? outputValue?.structuredContent)
  if (structured?.status === "waiting_for_person")
    return t("This action needs you. Take over the tab to continue.", {}, locale)
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

/** Monotonic row timestamps keep delayed tool completions in transcript order. */
export const getBrowserActivityTimestamps = (parts: readonly ToolCallPart[], fallback: number): number[] => {
  const times = parts.map((part) => part.startedAt ?? part.resolvedAt ?? fallback)

  return times.map((_, index) =>
    times.slice(index).reduce((earliest, time) => Math.min(earliest, time), Number.MAX_SAFE_INTEGER),
  )
}

export const getBrowserActivityTime = (timestamp: number, locale: Locale): string => {
  const language = locale === "pt-BR" ? "pt-BR" : "en-US"

  return new Date(timestamp).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
}

export const getBrowserActivityUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return ""

    return url.origin
  } catch {
    return ""
  }
}

/** Keep the header URL readable without exposing schemes, ports, credentials or query strings. */
export const getBrowserActivityShortUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (!["https:", "http:"].includes(url.protocol)) return ""

    return url.hostname
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

  return typeof args?.url === "string" ? getBrowserActivityShortUrl(args.url) : ""
}
