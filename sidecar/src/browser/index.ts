import type {
  BrowserFailureInfo,
  BrowserTarget,
  Kernel,
  RouteModule,
  ToolContext,
  ToolHandler,
  ToolRegistration,
  ToolResult,
} from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { asArray, asBoolean, asNumber, asRecord, asString } from "./utils"
import { createRoutedBrowserEngine } from "./vm-router"

export const name = "browser"

const OPEN_DEFAULT_TIMEOUT_MS = 20000

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

const timeout = (value: unknown, fallback = 10000, maximum = 30000): number =>
  Math.min(maximum, Math.max(1, requestedTimeout(value) ?? fallback))

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

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const mode = process.env.TOURI_BROWSER_EXECUTABLE === "chrome-for-testing" ? "chrome-for-testing" : "system-chrome"
  const engine = createRoutedBrowserEngine(kernel, mode, runStage ? { runStage } : {})
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
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.click({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: target(input.target),
            button: (asString(input.button) ?? "left") as "left" | "right" | "middle",
            clickCount: asNumber(input.clickCount) ?? 1,
            timeoutMs: budgetMs,
            signal,
          }),
      })
    }),
    tool("browser_type", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.type({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: target(input.target),
            text: asString(input.text) ?? "",
            clear: asBoolean(input.clear) !== false,
            submit: asBoolean(input.submit) === true,
            timeoutMs: budgetMs,
            signal,
          }),
      })
    }),
    tool("browser_press", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.press({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            key: asString(input.key) ?? "",
            timeoutMs: budgetMs,
            signal,
          }),
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
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.selectOption({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: target(input.target),
            values: asArray(input.values).map((value) => asString(value) ?? ""),
            signal,
            timeoutMs: budgetMs,
          }),
      })
    }),
    tool("browser_set_checked", async ({ ctx, args }) => {
      const input = argsRecord(args)
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.setChecked({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            target: target(input.target),
            checked: asBoolean(input.checked) === true,
            signal,
            timeoutMs: budgetMs,
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
      return withToolDeadline({
        ctx,
        timeoutMs: timeout(input.timeoutMs),
        run: ({ signal, budgetMs }) =>
          engine.evaluate({
            tabId: asString(input.tabId) ?? "",
            botId: ctx.botId,
            expression: asString(input.expression) ?? "",
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
        timeoutMs: timeout(input.timeoutMs, 600000, 1800000),
        signal: ctx.signal,
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
          const frame = await engine.preview({ botId, ...(query.tabId ? { tabId: query.tabId } : {}), signal })
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
          const running =
            kernel.services
              .use("vm.runtime")
              ?.states()
              .filter((machine) => machine.status === "running") ?? []
          await Promise.all(
            running
              .filter((machine) => !botId || machine.botId === botId)
              .map(async (machine) => {
                try {
                  // Same guest listing as browser_list_tabs; never starts a stopped machine.
                  await engine.list({ botId: machine.botId })
                } catch {
                  // Keep saved metadata available while the guest is reconnecting.
                }
              }),
          )
          return {
            status: 200,
            json: { tabs: engine.tabsForBot(botId), ...(botId ? { lastFailure: failures.get(botId) ?? null } : {}) },
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
          const ok = hold
            ? await engine.holdTakeover({ tabId, reason: "The user requested browser takeover" })
            : await engine.releaseTakeover(tabId)
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
