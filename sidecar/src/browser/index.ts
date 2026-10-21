import type {
  ApiModel,
  BrowserFailureInfo,
  BrowserSnapshot,
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
import { deviceSession } from "../kernel/device-session"
import type { PerformanceStageRunner } from "../kernel/performance"
import {
  type BrowserDecisionAction,
  type BrowserDecisionFallbackReason,
  createBrowserDecisionAdapter,
  getBrowserDecisionCandidates,
  isBrowserSubmitKey,
  isSafeBrowserRead,
  requiresBrowserKeyInspection,
  requiresBrowserTakeover,
} from "./decision"
import type { BrowserEngine } from "./types"
import { asArray, asBoolean, asNumber, asRecord, asString } from "./utils"
import { createRoutedBrowserEngine } from "./vm-router"

export const name = "browser"

const OPEN_DEFAULT_TIMEOUT_MS = 20000
const TAKEOVER_MINIMUM_TIMEOUT_MS = 120_000

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

const fields = (value: unknown): Array<{ kind: "username" | "password" | "otp"; target: BrowserTarget }> =>
  asArray(value).map((item) => {
    const field = argsRecord(item)
    return { kind: asString(field.kind) as "username" | "password" | "otp", target: target(field.target) }
  })

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

const getBrowserTakeoverRequiredResult = (): ToolResult => ({
  success: false,
  errorCode: "USER_TAKEOVER_REQUIRED",
  error:
    "TOURI_BROWSER_TAKEOVER_REQUIRED|sensitive_action\nAsk the user to take over this browser tab and complete the action directly, then resume only after they hand control back.",
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
      let uninspectableTarget = false
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
        } else uninspectableTarget = true
      }
      if (
        requiresBrowserTakeover({
          action,
          intent,
          pageUrl,
          submit,
          formSubmit,
          pointTarget: requestedTarget.kind === "point" || uninspectableTarget,
        })
      )
        return getBrowserTakeoverRequiredResult()

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
  const getVisibleTabs = (botId: string | null, signal: AbortSignal) => {
    const tabs = engine.tabsForBot(botId)
    const person = deviceSession(signal)?.person
    if (!person) return kernel.services.use("work.defaultPersonId") ? [] : tabs
    const canRead = kernel.services.use("work.canAccessBrowserTab")

    return tabs.filter(
      (tab) => canRead?.({ personId: person.id, role: person.role, tabId: tab.tabId }) ?? person.role === "admin",
    )
  }
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
  // The screen viewers show the real cause when a page never reached the display.
  const tool = (name: string, handler: ToolHandler): ToolRegistration => ({
    name,
    group: "browser",
    handler: async (input) => {
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
      const result = gate
        ? await gate.run(input.ctx, (signal) => handler({ ...input, ctx: { ...input.ctx, signal } }))
        : await handler(input)
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
              return getBrowserTakeoverRequiredResult()
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
      return engine.requestTakeover({
        tabId: asString(input.tabId) ?? "",
        botId: ctx.botId,
        reason: asString(input.reason) ?? "User assistance requested",
        timeoutMs: timeout(input.timeoutMs, 600000, 1800000, TAKEOVER_MINIMUM_TIMEOUT_MS),
        signal: ctx.signal,
        threadId: ctx.threadId,
        runId: ctx.runId,
      })
    }),
    tool("browser_submit_secret", async ({ ctx, args }) => {
      const input = argsRecord(args)
      const secretName = asString(input.secretName)
      const submit = asString(input.submit)
      const submitTarget = input.submitTarget === undefined ? undefined : target(input.submitTarget)
      return engine.submitSecret({
        tabId: asString(input.tabId) ?? "",
        botId: ctx.botId,
        threadId: ctx.threadId,
        projectId: ctx.projectId,
        fields: fields(input.fields),
        ...(secretName === null ? {} : { secretName }),
        submit: submit === "enter" || submit === "click" ? submit : "none",
        ...(submitTarget === undefined ? {} : { submitTarget }),
        signal: ctx.signal,
      })
    }),
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
          if (bot.machine !== "local") return { status: 409, json: { error: "Use a tela da máquina virtual" } }
          const tabs = getVisibleTabs(botId, signal)
          const tab = query.tabId ? tabs.find((tab) => tab.tabId === query.tabId) : tabs[0]
          const person = deviceSession(signal)?.person
          const scoped = person?.role === "member" || (!person && Boolean(kernel.services.use("work.defaultPersonId")))
          if (scoped && !tab) return { status: 404, json: { error: "Bot não encontrado" } }
          const tabId = scoped ? tab?.tabId : query.tabId
          const frame = await engine.preview({ botId, ...(tabId ? { tabId } : {}), signal })
          return frame
            ? { status: 200, json: frame }
            : { status: 409, json: { error: "Nenhuma página disponível para prévia" } }
        },
      },
      {
        method: "GET",
        path: "/browser/tabs",
        handler: async (request) => {
          const botId = request.query.botId ?? null
          const person = deviceSession(request.signal)?.person
          const unrestricted = person?.role === "admin" || (!person && !kernel.services.use("work.defaultPersonId"))
          const visibleBotIds = new Set(getVisibleTabs(botId, request.signal).map((tab) => tab.ownerBotId))
          const running =
            kernel.services
              .use("vm.runtime")
              ?.states()
              .filter((machine) => machine.status === "running") ?? []
          await Promise.all(
            running
              .filter(
                (machine) => (!botId || machine.botId === botId) && (unrestricted || visibleBotIds.has(machine.botId)),
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
          const canReadFailure =
            unrestricted ||
            Boolean(botId && person && kernel.services.use("work.ownsBot")?.({ personId: person.id, botId }))
          return {
            status: 200,
            json: {
              tabs: getVisibleTabs(botId, request.signal),
              ...(botId && canReadFailure ? { lastFailure: failures.get(botId) ?? null } : {}),
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
          const person = deviceSession(request.signal)?.person
          const personId = person?.id ?? (kernel.services.use("work.defaultPersonId") ? "" : "owner")
          const control = hold
            ? await engine.holdTakeoverForPerson({ tabId, personId })
            : await engine.releaseTakeoverForPerson({ tabId, personId })
          if (control === "forbidden")
            return {
              status: 403,
              json: {
                errorCode: "DENIED",
                error: "Só quem fez o pedido ou a pessoa responsável pelo bot pode controlar esta aba.",
              },
            }
          const ok = control === "held" || control === "released"
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
