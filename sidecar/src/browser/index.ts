import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import type {
  ApiModel,
  BrowserFailureInfo,
  BrowserSnapshot,
  BrowserTakeoverInput,
  BrowserTakeoverReason,
  BrowserTarget,
  Kernel,
  RouteModule,
  ToolContext,
  ToolHandler,
  ToolRegistration,
  ToolResult,
} from "@touri/contracts"
import { getApiModelKey } from "../api-models"
import { getBrowserDecisionModel } from "../api-models/config"
import { type DeviceSession, deviceSession } from "../kernel/device-session"
import type { PerformanceStageRunner } from "../kernel/performance"
import { createChannelBrowserRuns } from "./channel-runs"
import {
  type BrowserDecisionAction,
  type BrowserDecisionFallbackReason,
  createBrowserDecisionAdapter,
  getBrowserDecisionCandidates,
  getBrowserTakeoverReasonCode,
  isBrowserSubmitKey,
  isSafeBrowserRead,
  requiresBrowserKeyInspection,
  requiresBrowserTakeover,
} from "./decision"
import { createBrowserPreviewScopes } from "./preview-scopes"
import type { BrowserEngine } from "./types"
import { asArray, asBoolean, asNumber, asRecord, asString } from "./utils"
import { createRoutedBrowserEngine } from "./vm-router"

export const name = "browser"

const OPEN_DEFAULT_TIMEOUT_MS = 20000
const TAKEOVER_TIMEOUT_MS = 600000
const TAKEOVER_MINIMUM_TIMEOUT_MS = 120_000
const TAKEOVER_SESSION_TTL_MS = 30 * 60_000
const TAKEOVER_FRAME_INTERVAL_MS = 250
const MAX_TAKEOVER_SESSIONS = 16

type BrowserTakeoverSession = {
  id: string
  controlEpoch: string
  lifetime: AbortController
  botId: string
  deviceId: string
  personId: string | null
  channelRunId: string | null
  expiresAt: number
  lastFrameAt: number
  frameInFlight: boolean
  targetEpoch: number | null
  viewEpoch: number
  frameWidth: number | null
  frameHeight: number | null
  pendingInputs: number
  timer: ReturnType<typeof setTimeout> | null
  releaseVm: (() => Promise<void>) | null
}

const browserTakeoverInput = (value: unknown): BrowserTakeoverInput | null => {
  const input = asRecord(value)
  if (!input) return null
  if (input.kind === "text") {
    const text = asString(input.text)
    return text !== null && text.length > 0 && Buffer.byteLength(text) <= 16_384 && !text.includes("\0")
      ? { kind: "text", text }
      : null
  }
  if (input.kind === "key") {
    if (input.phase !== "down" && input.phase !== "up") return null
    const key = asString(input.key)
    const code = asString(input.code)
    const modifiers = asNumber(input.modifiers)
    if (!key || key.length > 40 || !code || code.length > 40 || modifiers === null || !Number.isInteger(modifiers))
      return null
    if (modifiers < 0 || modifiers > 15) return null
    return { kind: "key", phase: input.phase, key, code, modifiers }
  }
  if (input.kind !== "click" && input.kind !== "wheel") return null
  const x = asNumber(input.x)
  const y = asNumber(input.y)
  if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) return null
  if (input.kind === "click") {
    const button = asString(input.button)
    if (button !== null && !["left", "right", "middle"].includes(button)) return null
    return { kind: "click", x, y, ...(button === null ? {} : { button: button as "left" | "right" | "middle" }) }
  }
  if (input.kind === "wheel") {
    const deltaX = asNumber(input.deltaX)
    const deltaY = asNumber(input.deltaY)
    if (deltaX === null || deltaY === null || Math.abs(deltaX) > 1200 || Math.abs(deltaY) > 1200) return null
    return { kind: "wheel", x, y, deltaX, deltaY }
  }
  return null
}

export const target = (value: unknown): BrowserTarget => {
  if (typeof value === "string") return { kind: "ref", ref: value }
  const input = asRecord(value)
  if (input?.kind === undefined && typeof input?.ref === "string") return { kind: "ref", ref: input.ref }
  return value as BrowserTarget
}

const argsRecord = (value: unknown): Record<string, unknown> => asRecord(value) ?? {}

const requestedTimeout = (value: unknown): number | null => {
  if (typeof value === "string" && value.trim() !== "") return asNumber(Number(value))
  return asNumber(value)
}

const timeout = (value: unknown, fallback = 10000, maximum = 30000, minimum = 1): number =>
  Math.min(maximum, Math.max(minimum, requestedTimeout(value) ?? fallback))

// The engine (and the VM router) may add transport slack to a budget; reserve it so the
// tool itself still answers within the caller's timeoutMs with the engine's own cause.
const TOOL_DEADLINE_RESERVE_MS = 2500
const MIN_ENGINE_BUDGET_MS = 250

const engineBudget = (timeoutMs: number): number =>
  Math.max(
    Math.min(timeoutMs, MIN_ENGINE_BUDGET_MS),
    timeoutMs - Math.min(TOOL_DEADLINE_RESERVE_MS, Math.floor(timeoutMs / 4)),
  )

type Bounded = { signal: AbortSignal; budgetMs: number }

/** A browser tool never answers later than its timeoutMs; a late operation is cancelled with a coded pt-BR error. */
export const withToolDeadline = async ({
  ctx,
  timeoutMs,
  run,
}: {
  ctx: Pick<ToolContext, "signal">
  timeoutMs: number
  run: (bounded: Bounded) => Promise<ToolResult>
}): Promise<ToolResult> => {
  const controller = new AbortController()
  const message = `O navegador não concluiu a operação em ${Math.round(timeoutMs / 100) / 10} s (timeoutMs). A operação foi cancelada; tente novamente ou aumente timeoutMs.`
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(message))
      resolve({ success: false, errorCode: "DEADLINE_EXCEEDED", error: message })
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      run({ signal: AbortSignal.any([ctx.signal, controller.signal]), budgetMs: engineBudget(timeoutMs) }),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
  }
}

const getBrowserDecisionMarker = (reason: BrowserDecisionFallbackReason): string =>
  `TOURI_BROWSER_DECISION_HINT|${reason}`

const getFallbackInstruction = (reason: BrowserDecisionFallbackReason): string => {
  if (reason === "missing_key")
    return "The optional browser decision model has no saved API key. Continue with the existing browser behavior and ask the user if the target is still unclear."
  if (reason === "no_credit")
    return "The optional browser decision model has no credit. Continue with the existing browser behavior and ask the user if the target is still unclear."
  if (reason === "invalid_response")
    return "The optional browser decision model returned an invalid answer. Continue with the existing browser behavior and ask the user if the target is still unclear."

  return "The optional browser decision model could not be reached. Continue with the existing browser behavior and ask the user if the target is still unclear."
}

const withDecisionFallbackHint = (result: ToolResult, reason: BrowserDecisionFallbackReason): ToolResult => ({
  ...result,
  ...(result.success
    ? {}
    : { error: `${result.error}\n${getBrowserDecisionMarker(reason)}\n${getFallbackInstruction(reason)}` }),
})

const getSnapshot = (value: unknown): BrowserSnapshot | null => {
  const snapshot = asRecord(value)
  if (typeof snapshot?.tabId !== "string" || typeof snapshot.url !== "string" || !Array.isArray(snapshot.elements))
    return null

  return value as BrowserSnapshot
}

const isAmbiguousTarget = (result: ToolResult): boolean =>
  !result.success && ["AMBIGUOUS_TARGET", "TARGET_NOT_FOUND"].includes(result.errorCode)

const isBrowserTarget = (value: unknown): value is BrowserTarget => {
  const target = asRecord(value)
  if (!target) return false
  if (target.exact !== undefined && typeof target.exact !== "boolean") return false

  if (target.kind === "ref") return typeof target.ref === "string"
  if (target.kind === "role")
    return typeof target.role === "string" && (target.name === undefined || typeof target.name === "string")
  if (target.kind === "text") return typeof target.text === "string"
  if (target.kind === "css") return typeof target.selector === "string"
  if (target.kind === "point")
    return (
      typeof target.x === "number" &&
      Number.isFinite(target.x) &&
      typeof target.y === "number" &&
      Number.isFinite(target.y)
    )

  return false
}

const getTargetIntent = (target: BrowserTarget): string => {
  if (target.kind === "role") return [target.role, target.name].filter(Boolean).join(" ")
  if (target.kind === "text") return target.text

  return ""
}

const getDecisionName = (value: string, redact: (value: string) => string): string =>
  redact(value)
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number]")
    .slice(0, 120)

const getBrowserTakeoverRequiredResult = (reason: BrowserTakeoverReason = "sensitive_action"): ToolResult => ({
  success: false,
  errorCode: "USER_TAKEOVER_REQUIRED",
  error: `TOURI_BROWSER_TAKEOVER_REQUIRED|${reason}\nAsk the user to take over this browser tab and complete the action directly, then resume only after they hand control back.`,
})

type BrowserDecisionRun = (args: {
  target: BrowserTarget
  signal: AbortSignal
  timeoutMs: number
}) => Promise<ToolResult>

const runWithBrowserDecision = async ({
  ctx,
  timeoutMs,
  action,
  target: requestedTarget,
  tabId,
  botId,
  run,
  submit = false,
  button = "left",
  clickCount = 1,
  decide,
  snapshotBrowser,
  getPageUrl,
  redact,
}: {
  ctx: Pick<ToolContext, "signal">
  timeoutMs: number
  action: BrowserDecisionAction
  target: BrowserTarget
  tabId: string
  botId: string
  run: BrowserDecisionRun
  submit?: boolean | undefined
  button?: string | undefined
  clickCount?: number | undefined
  decide: ReturnType<typeof createBrowserDecisionAdapter>["decide"]
  snapshotBrowser: (args: {
    tabId: string
    botId: string
    image: "never"
    signal: AbortSignal
    timeoutMs: number
  }) => Promise<ToolResult>
  getPageUrl: (args: { tabId: string; botId: string }) => string
  redact: (value: string) => string
}): Promise<ToolResult> =>
  withToolDeadline({
    ctx,
    timeoutMs,
    run: async ({ signal, budgetMs }) => {
      if (!isBrowserTarget(requestedTarget))
        return { success: false, errorCode: "INVALID_ARGS", error: "Informe um alvo válido para usar o navegador." }

      const deadlineAt = Date.now() + budgetMs
      const remaining = (): number => Math.max(0, deadlineAt - Date.now())
      const runAction = (target: BrowserTarget): Promise<ToolResult> => {
        const timeoutMs = remaining()
        if (timeoutMs < MIN_ENGINE_BUDGET_MS)
          return Promise.resolve({
            success: false,
            errorCode: "DEADLINE_EXCEEDED",
            error: "O prazo para usar o navegador terminou. Tente novamente.",
          })

        return run({ target, signal, timeoutMs })
      }
      const pageUrl = getPageUrl({ tabId, botId })
      let intent = getTargetIntent(requestedTarget)
      let formSubmit = false
      if (requestedTarget.kind === "ref") {
        const inspect = await snapshotBrowser({
          tabId,
          botId,
          image: "never",
          signal,
          timeoutMs: remaining(),
        })
        const snapshot = inspect.success ? getSnapshot(inspect.structured) : null
        const element = snapshot?.elements.find((entry) => entry.ref === requestedTarget.ref)
        if (element) {
          intent = `${element.role} ${getDecisionName(element.name, redact)}`
          formSubmit = element.formSubmit === true
        } else
          return {
            success: false,
            errorCode: "TARGET_CHANGED",
            error: "The target is not in the current browser snapshot. Take a fresh snapshot and use one of its refs.",
          }
      }
      if (
        requiresBrowserTakeover({
          action,
          intent,
          pageUrl,
          submit,
          formSubmit,
          pointTarget: requestedTarget.kind === "point",
        })
      )
        return getBrowserTakeoverRequiredResult(
          getBrowserTakeoverReasonCode({
            error: submit || formSubmit ? "form_submit" : "",
            intent,
            pageUrl,
          }),
        )

      if (action === "click" && (button !== "left" || clickCount !== 1)) return runAction(requestedTarget)
      const initial = await runAction(requestedTarget)
      if (!isAmbiguousTarget(initial)) return initial
      if (requestedTarget.kind !== "role" && requestedTarget.kind !== "text") return initial

      const snapshotResult = await snapshotBrowser({
        tabId,
        botId,
        image: "never",
        signal,
        timeoutMs: remaining(),
      })
      if (!snapshotResult.success) return withDecisionFallbackHint(initial, "unavailable")
      const snapshot = getSnapshot(snapshotResult.structured)
      if (!snapshot) return withDecisionFallbackHint(initial, "invalid_response")

      const elements = snapshot.elements.map((element) => ({
        ...element,
        name: getDecisionName(element.name, redact),
      }))
      const prepared = getBrowserDecisionCandidates({
        action,
        target: requestedTarget,
        pageUrl: snapshot.url,
        elements,
        submit,
        button,
        clickCount,
      })
      if (!prepared) return initial

      const decision = await decide({
        action,
        intent: getDecisionName(prepared.intent, redact),
        candidates: prepared.candidates,
        signal,
      })
      if (decision.kind === "fallback") return withDecisionFallbackHint(initial, decision.reason)
      if (decision.kind === "ask") {
        const choices = decision.candidates.map((candidate) => candidate.name).join("; ")
        const marker = `TOURI_BROWSER_DECISION_QUESTION|${JSON.stringify({
          intent: getDecisionName(prepared.intent, redact),
          choices,
        })}`
        return {
          success: false,
          errorCode: "AMBIGUOUS_TARGET",
          error: `The browser did not choose a target safely. Ask the user which visible option to use, then retry only after they answer.\n${marker}`,
        }
      }

      return runAction({ kind: "ref", ref: decision.candidate.ref })
    },
  })

export type BrowserInitDependencies = {
  engine?: BrowserEngine
  fetchDecision?: (input: string, init: RequestInit) => Promise<Response>
  getDecisionApiKey?: (signal: AbortSignal) => Promise<string | null>
}

export const init = async (
  kernel: Kernel,
  runStage?: PerformanceStageRunner,
  dependencies: BrowserInitDependencies = {},
): Promise<void> => {
  const mode = process.env.TOURI_BROWSER_EXECUTABLE === "chrome-for-testing" ? "chrome-for-testing" : "system-chrome"
  const engine = dependencies.engine ?? createRoutedBrowserEngine(kernel, mode, runStage ? { runStage } : {})
  const channelRuns = createChannelBrowserRuns({ kernel, database: kernel.db as Database })
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") channelRuns.dispose()
  })
  let decisionModel: ApiModel | null = getBrowserDecisionModel(kernel)
  kernel.services.provide("browser.updateDecisionModel", (model) => {
    decisionModel = model?.browserDecisions === true ? model : null
  })
  const decision = createBrowserDecisionAdapter({
    getApiKey:
      dependencies.getDecisionApiKey ??
      (async (signal) => {
        if (!decisionModel) return null

        return getApiModelKey(kernel, decisionModel.id, signal)
      }),
    ...(dependencies.fetchDecision ? { fetchImpl: dependencies.fetchDecision } : {}),
  })
  const runDecision = ({
    ctx,
    timeoutMs,
    action,
    target: requestedTarget,
    tabId,
    botId,
    run,
    submit,
    button,
    clickCount,
  }: {
    ctx: Pick<ToolContext, "signal">
    timeoutMs: number
    action: BrowserDecisionAction
    target: BrowserTarget
    tabId: string
    botId: string
    run: BrowserDecisionRun
    submit?: boolean | undefined
    button?: string | undefined
    clickCount?: number | undefined
  }): Promise<ToolResult> =>
    runWithBrowserDecision({
      ctx,
      timeoutMs,
      action,
      target: requestedTarget,
      tabId,
      botId,
      run,
      decide: decision.decide,
      snapshotBrowser: (args) => engine.snapshot(args),
      getPageUrl: ({ tabId, botId }) => engine.tabsForBot(botId).find((tab) => tab.tabId === tabId)?.url ?? "",
      redact: kernel.redact,
      submit,
      button,
      clickCount,
    })
  const failures = new Map<string, BrowserFailureInfo>()
  const visibleTabsFor = (
    botId: string | null,
    person: NonNullable<ReturnType<typeof deviceSession>>["person"] | undefined,
  ) =>
    engine.tabsForBot(botId).filter((tab) => {
      if (!person || kernel.services.use("work.ownsBot")?.({ personId: person.id, botId: tab.ownerBotId ?? "" }))
        return true
      const canRead = kernel.services.use("work.canAccessBrowserTab")
      if (canRead) return canRead({ personId: person.id, role: person.role, tabId: tab.tabId })
      const row = (kernel.db as Database)
        .query("SELECT owner_thread_id FROM browser_tabs WHERE id = ?")
        .get(tab.tabId) as { owner_thread_id: string | null } | null
      if (!row?.owner_thread_id)
        return Boolean(
          kernel.services.use("work.canAccessBot")?.({
            personId: person.id,
            role: person.role,
            botId: tab.ownerBotId ?? "",
          }),
        )
      return Boolean(
        kernel.services.use("work.canAccessThread")?.({
          personId: person.id,
          role: person.role,
          threadId: row.owner_thread_id,
        }),
      )
    })
  const getTakeoverController = (device: DeviceSession | undefined) => ({
    deviceId: device?.deviceId ?? "native",
    personId: device ? (device.person?.id ?? null) : (kernel.services.use("work.defaultPersonId")?.() ?? "owner"),
  })
  const isTakeoverController = (device: DeviceSession | undefined, session: BrowserTakeoverSession): boolean => {
    const controller = getTakeoverController(device)

    return session.deviceId === controller.deviceId && session.personId === controller.personId
  }
  const takeoverSessions = new Map<string, BrowserTakeoverSession>()
  const takeoverStarts = new Map<string, Promise<BrowserTakeoverSession | null>>()
  const renewTakeoverSession = (tabId: string, session: BrowserTakeoverSession): BrowserTakeoverSession => {
    if (session.timer) clearTimeout(session.timer)
    const expiresAt = Date.now() + TAKEOVER_SESSION_TTL_MS
    const timer = setTimeout(() => {
      const current = takeoverSessions.get(tabId)
      if (current?.id !== session.id || current.expiresAt > Date.now()) return
      void revokeTakeoverSession(tabId, session.id)
    }, TAKEOVER_SESSION_TTL_MS)
    timer.unref()
    const renewed = { ...session, expiresAt, timer }
    takeoverSessions.set(tabId, renewed)
    return renewed
  }
  const endTakeoverSession = async (tabId: string, sessionId?: string): Promise<boolean> => {
    const session = takeoverSessions.get(tabId)
    if (!session || (sessionId && session.id !== sessionId)) return false
    if (session.timer) clearTimeout(session.timer)
    session.lifetime.abort()
    takeoverSessions.delete(tabId)
    if (session.channelRunId && session.personId)
      channelRuns.returnControl({ runId: session.channelRunId, actorPersonId: session.personId })
    const released = await engine.releaseTakeover(tabId).catch(() => false)
    if (session.releaseVm) await session.releaseVm().catch(() => undefined)
    return released
  }
  const revokeTakeoverSession = async (tabId: string, sessionId?: string): Promise<void> => {
    const session = takeoverSessions.get(tabId)
    if (!session || (sessionId && session.id !== sessionId)) return
    if (session.timer) clearTimeout(session.timer)
    session.lifetime.abort()
    takeoverSessions.delete(tabId)
    if (session.releaseVm) await session.releaseVm().catch(() => undefined)
  }
  const removeTakeoverSession = (tabId: string): void => {
    void revokeTakeoverSession(tabId)
  }
  const authorizeTakeoverSession = (request: {
    signal: AbortSignal
    params: Record<string, string>
    body: unknown
  }) => {
    const device = deviceSession(request.signal)
    const body = argsRecord(request.body)
    const sessionId = asString(body.sessionId)
    const controlEpoch = asString(body.controlEpoch)
    const tabId = request.params.id ?? ""
    const session = takeoverSessions.get(tabId)
    if (!session || sessionId !== session.id) return null
    if (session.controlEpoch !== controlEpoch) return null
    if (!isTakeoverController(device, session)) return null
    const canView = !device?.person || visibleTabsFor(null, device.person).some((tab) => tab.tabId === tabId)
    if ((device && !device.active()) || !canView || session.expiresAt <= Date.now()) {
      removeTakeoverSession(tabId)
      return null
    }
    return { device, session }
  }
  let shutdownPromise: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      unhostSessions()
      channelRuns.dispose()
      const sessions = Array.from(takeoverSessions.values())
      takeoverSessions.clear()
      sessions.forEach((session) => {
        session.lifetime.abort()
        if (session.timer) clearTimeout(session.timer)
      })
      await engine.shutdown()
      await Promise.all(sessions.map((session) => session.releaseVm?.().catch(() => undefined)))
    })()
    return shutdownPromise
  }
  const unhostSessions = kernel.onHostNotification(({ method }) => {
    if (method === "app.willQuit") void shutdown()
  })
  kernel.services.provide("browser.shutdown", shutdown)
  kernel.services.provide("browser.cancelRequest", ({ runId, reason }) => {
    const request = channelRuns.cancelRequest(runId, reason === "timeout" ? "failed" : "canceled")
    if (!request) return null
    engine
      .tabsForBot(request.botId)
      .filter(
        (tab) =>
          request.ownsControl &&
          tab.heldByUser &&
          (tab.takeoverRunId === request.requestId || tab.takeoverRunId === request.runId),
      )
      .forEach((tab) => {
        void revokeTakeoverSession(tab.tabId)
        void engine.cancelTakeover({ tabId: tab.tabId })
      })
    return request.runId
  })
  const previewScopes = createBrowserPreviewScopes()
  // The screen viewers show the real cause when a page never reached the display.
  const tool = (name: string, handler: ToolHandler): ToolRegistration => ({
    name,
    group: "browser",
    handler: async (input) => {
      const channelAccess = await channelRuns.enter(input.ctx)
      if (!channelAccess.success)
        return { success: false, errorCode: channelAccess.errorCode, error: channelAccess.error }
      if (channelAccess.queued)
        return {
          success: true,
          content: [
            {
              type: "text",
              text: "Waiting for this bot's current browser request to finish. End this turn; touri will continue this request automatically.",
            },
          ],
          structured: { status: "waiting_for_browser", requestRunId: input.ctx.runId },
        }
      const bot = kernel.services.use("store.api")?.getBot({ botId: input.ctx.botId })
      const writes = ![
        "browser_list_tabs",
        "browser_snapshot",
        "browser_screenshot",
        "browser_wait_for",
        "browser_request_takeover",
      ].includes(name)
      const vmInput = bot?.machine === "vm" && bot.browser === "machine" && writes
      const gate = vmInput ? kernel.services.use("computer.input") : null
      if (vmInput && !gate) return { success: false, errorCode: "COMPUTER_DISABLED", error: "Controle indisponível" }
      previewScopes.set(input.ctx.botId, input.ctx.threadId)
      const result = gate
        ? await gate.run(input.ctx, (signal) => handler({ ...input, ctx: { ...input.ctx, signal } }))
        : await handler(input)
      if (!result.success && result.errorCode === "USER_TAKEOVER_REQUIRED") {
        const args = argsRecord(input.args)
        const tabId = asString(args.tabId)
        if (!tabId) return result
        const pageUrl = engine.tabsForBot(input.ctx.botId).find((tab) => tab.tabId === tabId)?.url ?? ""
        const intent =
          args.target === undefined ? (asString(args.expression) ?? "") : getTargetIntent(target(args.target))
        const reasonCode = getBrowserTakeoverReasonCode({ error: result.error, intent, pageUrl })
        return engine.requestTakeover({
          tabId,
          botId: input.ctx.botId,
          reason: reasonCode,
          reasonCode,
          timeoutMs: TAKEOVER_TIMEOUT_MS,
          signal: input.ctx.signal,
          threadId: input.ctx.threadId,
          runId: input.ctx.runId,
        })
      }
      if (!result.success)
        failures.set(input.ctx.botId, {
          tool: name,
          errorCode: result.errorCode,
          error: kernel.redact(result.error).slice(0, 600),
          at: Date.now(),
        })
      else if (name === "browser_open" || name === "browser_navigate") failures.delete(input.ctx.botId)
      return result
    },
  })

  const handlers: Array<ToolRegistration> = [
    tool("browser_open", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs, OPEN_DEFAULT_TIMEOUT_MS),
        run: ({ signal, budgetMs }) =>
          engine.open({ url: asString(input.url) ?? "about:blank", ctx: { ...ctx, signal }, timeoutMs: budgetMs }),
      })
    }),
    tool("browser_list_tabs", async ({ ctx, args }) =>
      withToolDeadline({
        ctx,
        timeoutMs: timeout(argsRecord(args).timeoutMs),
        run: ({ signal, budgetMs }) => engine.list({ botId: ctx.botId, signal, timeoutMs: budgetMs }),
      }),
    ),
    tool("browser_close_tab", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.close({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_snapshot", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const image = asString(input.image)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.snapshot({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            image: image === "always" || image === "never" ? image : "auto",
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_screenshot", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.screenshot({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            fullPage: asBoolean(input.fullPage) === true,
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_navigate", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const url = asString(input.url)
      const action = asString(input.action) ?? "goto"
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.navigate({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            ...(url === null ? {} : { url }),
            action,
            timeoutMs: budgetMs,
            signal,
          }),
      })
    }),
    tool("browser_click", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const button = (asString(input.button) ?? "left") as "left" | "right" | "middle"
      const clickCount = asNumber(input.clickCount) ?? 1
      const requestedTarget = target(input.target)
      return runDecision({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        action: "click",
        target: requestedTarget,
        tabId,
        botId: ctx.botId,
        button,
        clickCount,
        run: ({ target, signal, timeoutMs }) =>
          engine.click({
            tabId,
            botId: ctx.botId,
            target,
            button,
            clickCount,
            timeoutMs,
            signal,
          }),
      })
    }),
    tool("browser_type", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const submit = asBoolean(input.submit) === true
      const requestedTarget = target(input.target)
      return runDecision({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        action: "type",
        target: requestedTarget,
        tabId,
        botId: ctx.botId,
        submit,
        run: ({ target, signal, timeoutMs }) =>
          engine.type({
            tabId,
            botId: ctx.botId,
            target,
            text: asString(input.text) ?? "",
            clear: asBoolean(input.clear) !== false,
            submit,
            timeoutMs,
            signal,
          }),
      })
    }),
    tool("browser_press", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const key = asString(input.key) ?? ""
      const enterKey = isBrowserSubmitKey(key)
      const inspectFocus = requiresBrowserKeyInspection(key)
      const pageUrl = engine.tabsForBot(ctx.botId).find((tab) => tab.tabId === tabId)?.url ?? ""
      if (inspectFocus && requiresBrowserTakeover({ action: "click", intent: "", pageUrl }))
        return getBrowserTakeoverRequiredResult()

      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: async ({ signal, budgetMs }) => {
          if (inspectFocus) {
            const inspected = await engine.snapshot({
              tabId,
              botId: ctx.botId,
              image: "never",
              signal,
              timeoutMs: budgetMs,
            })
            const snapshot = inspected.success ? getSnapshot(inspected.structured) : null
            if (!snapshot) return getBrowserTakeoverRequiredResult()
            const focused = snapshot.elements.find((element) => element.ref === snapshot.focus.ref)
            if (!focused) return getBrowserTakeoverRequiredResult()
            const action = ["textbox", "searchbox", "combobox"].includes(focused.role) ? "type" : "click"
            if (
              requiresBrowserTakeover({
                action,
                intent: `${focused.role} ${focused.name}`,
                pageUrl: snapshot.url,
                submit: enterKey && focused.formAssociated === true,
                formSubmit: focused.formSubmit === true,
              })
            )
              return getBrowserTakeoverRequiredResult(
                getBrowserTakeoverReasonCode({
                  error: enterKey && (focused.formAssociated || focused.formSubmit) ? "form_submit" : "",
                  intent: `${focused.role} ${focused.name}`,
                  pageUrl: snapshot.url,
                }),
              )
          }

          return engine.press({
            tabId,
            botId: ctx.botId,
            key,
            timeoutMs: budgetMs,
            signal,
          })
        },
      })
    }),
    tool("browser_hover", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.hover({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: target(input.target),
            timeoutMs: budgetMs,
            signal,
          }),
      })
    }),
    tool("browser_scroll", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.scroll({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: input.target === undefined ? null : target(input.target),
            direction: asString(input.direction) === "up" ? "up" : "down",
            pages: asNumber(input.pages) ?? 1,
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_select_option", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const requestedTarget = target(input.target)
      const values = asArray(input.values).map((value) => asString(value) ?? "")
      return runDecision({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        action: "select",
        target: requestedTarget,
        tabId,
        botId: ctx.botId,
        run: ({ target, signal, timeoutMs }) =>
          engine.selectOption({
            tabId,
            botId: ctx.botId,
            target,
            values,
            signal,
            timeoutMs,
          }),
      })
    }),
    tool("browser_set_checked", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const requestedTarget = target(input.target)
      return runDecision({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        action: "check",
        target: requestedTarget,
        tabId,
        botId: ctx.botId,
        run: ({ target, signal, timeoutMs }) =>
          engine.setChecked({
            tabId,
            botId: ctx.botId,
            target,
            checked: asBoolean(input.checked) === true,
            signal,
            timeoutMs,
          }),
      })
    }),
    tool("browser_wait_for", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.waitFor({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            condition: input.condition,
            timeoutMs: budgetMs,
            signal,
          }),
      })
    }),
    tool("browser_upload_files", async () => ({
      success: false,
      errorCode: "INVALID_ARGS",
      error: "File upload is not enabled in the MVP browser.",
    })),
    tool("browser_evaluate", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const tabId = asString(input.tabId) ?? ""
      const expression = asString(input.expression) ?? ""
      const pageUrl = engine.tabsForBot(ctx.botId).find((tab) => tab.tabId === tabId)?.url ?? ""
      if (!isSafeBrowserRead(expression) || requiresBrowserTakeover({ action: "click", intent: expression, pageUrl }))
        return getBrowserTakeoverRequiredResult()

      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.evaluate({
            tabId,
            botId: ctx.botId,
            expression,
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_request_takeover", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const requestedReason = asString(input.reason)
      const reason = requestedReason ?? "User assistance requested"
      const pageUrl = engine.tabsForBot(ctx.botId).find((tab) => tab.tabId === input.tabId)?.url ?? ""
      const reasonCode = requestedReason
        ? getBrowserTakeoverReasonCode({ intent: requestedReason, pageUrl })
        : "requested"
      const managedNeedsYou = channelRuns.needsYou(ctx.runId, reason)
      return engine.requestTakeover({
        tabId: asString(input.tabId) ?? "",
        botId: ctx.botId,
        reason,
        reasonCode,
        timeoutMs: timeout(input.timeoutMs, 600000, 1800000, TAKEOVER_MINIMUM_TIMEOUT_MS),
        signal: ctx.signal,
        notify: !managedNeedsYou,
        threadId: ctx.threadId,
        runId: ctx.runId,
      })
    }),
    tool("browser_submit_secret", async () => getBrowserTakeoverRequiredResult("login")),
  ]
  const registration = kernel.registerTools({ tools: handlers })
  if (!registration.success)
    kernel.log({
      level: "error",
      module: name,
      msg: "Browser tools were not registered",
      data: { error: registration.error },
    })

  const routes: RouteModule = {
    name,
    routes: [
      {
        method: "GET",
        path: "/bots/:id/browser-preview",
        handler: async ({ params, query, signal }) => {
          const botId = params.id ?? ""
          const bot = kernel.services.use("store.api")?.getBot({ botId })
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          const person = deviceSession(signal)?.person
          if (person && !kernel.services.use("work.canAccessBot")?.({ personId: person.id, role: person.role, botId }))
            return { status: 404, json: { error: "Bot não encontrado" } }
          if (Array.from(takeoverSessions.values()).some((session) => session.botId === botId))
            return { status: 409, json: { error: "A prévia fica oculta enquanto alguém controla o navegador." } }
          if (bot.machine !== "local") return { status: 409, json: { error: "Use a tela da máquina virtual" } }
          const visibleTabs = visibleTabsFor(botId, person)
          if (person && query.tabId && !visibleTabs.some((tab) => tab.tabId === query.tabId))
            return { status: 404, json: { error: "Página não encontrada" } }
          const selectedTabId = query.tabId ?? visibleTabs[0]?.tabId
          if (person && !selectedTabId) return { status: 404, json: { error: "Página não encontrada" } }
          if (selectedTabId && channelRuns.isPreviewHidden(selectedTabId))
            return {
              status: 409,
              json: {
                errorCode: "BROWSER_PREVIEW_HIDDEN",
                error: "A prévia fica oculta enquanto alguém está no controle.",
              },
            }
          const capture = () =>
            selectedTabId
              ? engine.preview({ botId, tabId: selectedTabId, signal })
              : engine.preview({ botId, ...(query.tabId ? { tabId: query.tabId } : {}), signal })
          const frame =
            person?.role === "member"
              ? await previewScopes.capture({
                  botId,
                  canReadThread: (threadId) =>
                    kernel.services.use("work.canAccessThread")?.({
                      personId: person.id,
                      role: person.role,
                      threadId,
                    }) === true,
                  capture,
                })
              : await capture()
          const device = deviceSession(signal)
          if (
            device &&
            (!device.active() || !visibleTabsFor(botId, device.person).some((tab) => tab.tabId === selectedTabId))
          )
            return { status: 404, json: { error: "Página não encontrada" } }
          return frame
            ? { status: 200, json: frame }
            : { status: 409, json: { error: "Nenhuma página disponível para prévia" } }
        },
      },
      {
        method: "POST",
        path: "/browser/tabs/:id/takeover/session",
        handler: async ({ params, signal }) => {
          const device = deviceSession(signal)
          const controller = getTakeoverController(device)
          if (device && !device.active())
            return { status: 401, json: { error: "Conecte o dispositivo para assumir o navegador." } }
          const tabId = params.id ?? ""
          const tab = visibleTabsFor(null, device?.person).find((candidate) => candidate.tabId === tabId)
          if (!tab?.ownerBotId || tab.state === "closed")
            return { status: 404, json: { error: "A página do navegador não está disponível." } }
          const bot = kernel.services.use("store.api")?.getBot({ botId: tab.ownerBotId })
          if (!bot) return { status: 404, json: { error: "O bot desta página não está disponível." } }

          const existing = takeoverSessions.get(tabId)
          if (existing && existing.expiresAt > Date.now()) {
            if (!isTakeoverController(device, existing))
              return { status: 409, json: { error: "Outra pessoa está controlando esta página." } }
            const renewed = renewTakeoverSession(tabId, existing)
            return {
              status: 200,
              json: { sessionId: renewed.id, controlEpoch: renewed.controlEpoch, viewEpoch: renewed.viewEpoch },
            }
          }
          if (existing) await endTakeoverSession(tabId, existing.id)
          let starting = takeoverStarts.get(tabId)
          if (!starting && takeoverSessions.size + takeoverStarts.size >= MAX_TAKEOVER_SESSIONS)
            return {
              status: 429,
              json: { error: "Há muitas páginas em controle remoto. Encerre uma sessão e tente de novo." },
            }
          if (!starting) {
            starting = (async () => {
              const channelRun = channelRuns.getForTab(tabId)
              const actorPersonId = controller.personId
              if (channelRun && !actorPersonId) return null
              if (channelRun && actorPersonId) {
                const control = channelRuns.takeControl({ runId: channelRun.runId, actorPersonId })
                if (!control.success) return null
              }
              const undoChannelControl = (): void => {
                if (channelRun && actorPersonId)
                  channelRuns.restoreControl({ runId: channelRun.runId, actorPersonId, status: channelRun.status })
              }
              let releaseVm: (() => Promise<void>) | null = null
              if (bot.browser === "machine") {
                const vm = kernel.services.use("vm.runtime")
                if (!vm) {
                  undoChannelControl()
                  return null
                }
                try {
                  releaseVm = await vm.acquire({ botId: bot.id, runningOnly: true, signal })
                } catch {
                  undoChannelControl()
                  return null
                }
              }

              const hold = async (): Promise<boolean> => {
                if (!channelRun && kernel.services.use("work.defaultPersonId")) {
                  const status = await engine.holdTakeoverForPerson({ tabId, personId: actorPersonId ?? "" })
                  return status === "held"
                }
                return engine.holdTakeover({
                  tabId,
                  reason: "The user requested browser takeover",
                  ...(channelRun ? { runId: channelRuns.getCurrentRunId(channelRun.runId) ?? channelRun.runId } : {}),
                })
              }
              const held = await hold().catch(() => false)
              if (!held) {
                await releaseVm?.().catch(() => undefined)
                undoChannelControl()
                return null
              }
              return renewTakeoverSession(tabId, {
                id: randomBytes(32).toString("hex"),
                controlEpoch: randomBytes(16).toString("hex"),
                lifetime: new AbortController(),
                botId: tab.ownerBotId ?? "",
                deviceId: controller.deviceId,
                personId: controller.personId,
                channelRunId: channelRun?.runId ?? null,
                expiresAt: 0,
                lastFrameAt: 0,
                frameInFlight: false,
                targetEpoch: null,
                viewEpoch: 0,
                frameWidth: null,
                frameHeight: null,
                pendingInputs: 0,
                timer: null,
                releaseVm,
              })
            })()
            takeoverStarts.set(tabId, starting)
          }

          const session = await starting
          if (takeoverStarts.get(tabId) === starting) takeoverStarts.delete(tabId)
          if (!session) return { status: 409, json: { error: "Não foi possível pausar o navegador. Tente novamente." } }
          if (!isTakeoverController(device, session))
            return { status: 409, json: { error: "Outra pessoa está controlando esta página." } }
          return {
            status: 200,
            json: { sessionId: session.id, controlEpoch: session.controlEpoch, viewEpoch: session.viewEpoch },
          }
        },
      },
      {
        method: "POST",
        path: "/browser/tabs/:id/takeover/frame",
        handler: async (request) => {
          const tabId = request.params.id ?? ""
          const authorized = authorizeTakeoverSession(request)
          if (!authorized) return { status: 403, json: { error: "Esta sessão de controle não está ativa." } }
          const requestedViewEpoch = asNumber(argsRecord(request.body).viewEpoch)
          if (
            requestedViewEpoch === null ||
            !Number.isSafeInteger(requestedViewEpoch) ||
            requestedViewEpoch < authorized.session.viewEpoch
          )
            return { status: 409, json: { error: "A visualização mudou. Atualize a página do navegador." } }
          const now = Date.now()
          if (
            authorized.session.frameInFlight ||
            (requestedViewEpoch === authorized.session.viewEpoch &&
              now - authorized.session.lastFrameAt < TAKEOVER_FRAME_INTERVAL_MS)
          )
            return { status: 429, json: { error: "Aguarde a próxima imagem do navegador." } }
          const viewChanged = requestedViewEpoch > authorized.session.viewEpoch
          const active = renewTakeoverSession(tabId, {
            ...authorized.session,
            viewEpoch: requestedViewEpoch,
            frameInFlight: true,
            lastFrameAt: now,
            ...(viewChanged ? { targetEpoch: null, frameWidth: null, frameHeight: null } : {}),
          })
          const frame = await engine
            .takeoverFrame({
              tabId,
              botId: active.botId,
              signal: AbortSignal.any([request.signal, active.lifetime.signal]),
            })
            .catch(() => null)
          const current = authorizeTakeoverSession(request)?.session
          if (current?.id !== active.id || current.viewEpoch !== active.viewEpoch)
            return { status: 403, json: { error: "Esta sessão de controle não está ativa." } }
          const completed = renewTakeoverSession(tabId, {
            ...current,
            frameInFlight: false,
            ...(frame ? { targetEpoch: frame.targetEpoch, frameWidth: frame.width, frameHeight: frame.height } : {}),
          })
          return frame
            ? {
                status: 200,
                json: { ...frame, controlEpoch: completed.controlEpoch, viewEpoch: completed.viewEpoch },
              }
            : { status: 409, json: { error: "A imagem do navegador está indisponível." } }
        },
      },
      {
        method: "POST",
        path: "/browser/tabs/:id/takeover/input",
        handler: async (request) => {
          const tabId = request.params.id ?? ""
          const authorized = authorizeTakeoverSession(request)
          if (!authorized) return { status: 403, json: { error: "Esta sessão de controle não está ativa." } }
          const body = argsRecord(request.body)
          const targetEpoch = asNumber(body.targetEpoch)
          const viewEpoch = asNumber(body.viewEpoch)
          const width = asNumber(body.width)
          const height = asNumber(body.height)
          if (
            targetEpoch === null ||
            targetEpoch !== authorized.session.targetEpoch ||
            viewEpoch !== authorized.session.viewEpoch ||
            width === null ||
            width !== authorized.session.frameWidth ||
            height === null ||
            height !== authorized.session.frameHeight
          )
            return { status: 409, json: { error: "A visualização mudou. Atualize a página do navegador." } }
          const input = browserTakeoverInput(argsRecord(request.body).input)
          if (!input) return { status: 400, json: { error: "Ação de navegador inválida." } }
          if (authorized.session.pendingInputs >= 32)
            return { status: 429, json: { error: "O navegador está recebendo muitas ações. Tente novamente." } }
          renewTakeoverSession(tabId, {
            ...authorized.session,
            pendingInputs: authorized.session.pendingInputs + 1,
          })
          let sent = false
          try {
            sent = await engine
              .takeoverInput({
                tabId,
                botId: authorized.session.botId,
                targetEpoch,
                width,
                height,
                input,
                signal: AbortSignal.any([request.signal, authorized.session.lifetime.signal]),
              })
              .catch(() => false)
          } finally {
            const current = takeoverSessions.get(tabId)
            if (current?.id === authorized.session.id)
              renewTakeoverSession(tabId, {
                ...current,
                pendingInputs: Math.max(0, current.pendingInputs - 1),
              })
          }
          return sent
            ? { status: 200, json: {} }
            : { status: 409, json: { error: "O navegador não recebeu a ação. Tente novamente." } }
        },
      },
      {
        method: "DELETE",
        path: "/browser/tabs/:id/takeover/session",
        handler: async (request) => {
          const tabId = request.params.id ?? ""
          const authorized = authorizeTakeoverSession(request)
          if (!authorized) return { status: 403, json: { error: "Esta sessão de controle não está ativa." } }
          const released = await endTakeoverSession(tabId, authorized.session.id)
          return released
            ? { status: 200, json: {} }
            : { status: 404, json: { error: "A página do navegador não está mais disponível." } }
        },
      },
      {
        method: "GET",
        path: "/browser/tabs",
        handler: async (request) => {
          const botId = request.query.botId ?? null
          const person = deviceSession(request.signal)?.person
          const running =
            kernel.services
              .use("vm.runtime")
              ?.states()
              .filter((machine) => machine.status === "running") ?? []
          await Promise.all(
            running
              .filter((machine) => !botId || machine.botId === botId)
              .filter(
                (machine) =>
                  !person ||
                  kernel.services.use("work.canAccessBot")?.({
                    personId: person.id,
                    role: person.role,
                    botId: machine.botId,
                  }) === true,
              )
              .map(async (machine) => {
                try {
                  // Same guest listing as browser_list_tabs; never starts a stopped machine.
                  await engine.list({ botId: machine.botId })
                } catch {
                  // Keep saved metadata available while the guest is reconnecting.
                }
              }),
          )
          const tabs = visibleTabsFor(botId, person).map((tab) => {
            if (!takeoverSessions.has(tab.tabId)) return tab
            return { ...tab, title: "", url: "" }
          })
          return {
            status: 200,
            json: {
              tabs,
              ...(botId && (!person || kernel.services.use("work.ownsBot")?.({ personId: person.id, botId }))
                ? { lastFailure: failures.get(botId) ?? null }
                : {}),
            },
          }
        },
      },
      {
        method: "POST",
        path: "/browser/tabs/:id/takeover",
        handler: async (request) => {
          const body = argsRecord(request.body)
          const hold = asBoolean(body.hold) === true
          const tabId = request.params.id ?? ""
          const device = deviceSession(request.signal)
          const actorPersonId = getTakeoverController(device).personId
          const controller = takeoverSessions.get(tabId)
          if (controller && ((device && !device.active()) || !isTakeoverController(device, controller)))
            return { status: 403, json: { error: "Somente quem assumiu o navegador pode devolver o controle." } }
          const channelRun = channelRuns.getForTab(tabId)
          if (channelRun && !controller && !actorPersonId)
            return { status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN", error: "Acesso não autorizado." } }
          if (actorPersonId && channelRun && !controller) {
            const control = hold
              ? channelRuns.takeControl({ runId: channelRun.runId, actorPersonId })
              : channelRuns.returnControl({ runId: channelRun.runId, actorPersonId })
            if (!control.success)
              return { status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN", error: control.error } }
          }
          const applyUnmanagedControl = async () => {
            if (controller || channelRun) return null
            const personId = actorPersonId ?? ""
            if (hold) return engine.holdTakeoverForPerson({ tabId, personId })
            return engine.releaseTakeoverForPerson({ tabId, personId })
          }
          const release = await applyUnmanagedControl()
          if (release === "forbidden")
            return {
              status: 403,
              json: {
                errorCode: "BROWSER_CONTROL_FORBIDDEN",
                error: "Só quem pediu ou a pessoa responsável pelo bot pode devolver o controle.",
              },
            }
          const applyControl = async (): Promise<boolean> => {
            if (controller && !hold) return endTakeoverSession(tabId, controller.id)
            if (release !== null) return release === "held" || release === "released"
            if (!hold) return engine.releaseTakeover(tabId)
            return engine.holdTakeover({
              tabId,
              reason: "The user requested browser takeover",
              ...(channelRun ? { runId: channelRuns.getCurrentRunId(channelRun.runId) ?? channelRun.runId } : {}),
            })
          }
          const ok = await applyControl()
          if (!ok && actorPersonId && channelRun && !controller)
            channelRuns.restoreControl({ runId: channelRun.runId, actorPersonId, status: channelRun.status })
          return ok
            ? { status: 200, json: {} }
            : {
                status: 404,
                json: {
                  errorCode: "TAB_NOT_FOUND",
                  error: hold
                    ? "Não foi possível assumir a aba: ela foi fechada ou o navegador da máquina não respondeu. Reconecte e tente de novo."
                    : "Não foi possível devolver a aba: ela foi fechada ou o navegador da máquina não respondeu.",
                },
              }
        },
      },
      {
        method: "POST",
        path: "/browser/secret-entry/:id",
        handler: async (request) => {
          const body = argsRecord(request.body)
          const cancel = asBoolean(body.cancel) === true
          const secretName = asString(body.secretName)
          const ok = await engine.secretEntry({
            tabId: request.params.id ?? "",
            ...(secretName === null ? {} : { secretName }),
            cancel,
          })
          return ok
            ? { status: 200, json: {} }
            : {
                status: 404,
                json: { errorCode: "SECRET_REQUEST_NOT_FOUND", error: "No pending secret request was found." },
              }
        },
      },
    ],
  }
  kernel.registerRoutes(routes)
  kernel.services.provide("browser.tabsForBot", ({ botId }) => engine.tabsForBot(botId))
}
