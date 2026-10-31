import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot, BrowserTabInfo, Run, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BrowserActivityCard } from "../src/components/BrowserActivityCard"
import { BrowserActivityControlsProvider } from "../src/components/BrowserActivityControls"
import { BrowserWorkingStatus } from "../src/components/BrowserWorkingStatus"
import {
  getBrowserActivityCurrentLabel,
  getBrowserActivityLabel,
  getBrowserActivityNotice,
  getBrowserActivityShortUrl,
  getBrowserActivityTabId,
  getBrowserActivityTimestamps,
  getBrowserActivityUrl,
  getBrowserTakeoverReason,
  isBrowserRequestQueued,
} from "../src/components/browserActivityPresentation"
import { ApiError } from "../src/errors"
import { ChannelComposerChip } from "../src/features/channelBrowser/ChannelBrowser"
import { clearBrowserHold, setBrowserHold } from "../src/features/desktop/browserHold"
import { InlinePreviewContext } from "../src/features/desktop/InlineLivePreview"
import { startInlineFrameSource } from "../src/features/desktop/inlineFrameSource"
import { setInlinePreviewPreference } from "../src/features/desktop/inlinePreviewPreference"
import { type Locale, t } from "../src/i18n"

vi.mock("../src/features/desktop/inlineFrameSource", () => ({
  startInlineFrameSource: vi.fn(
    (
      _api: unknown,
      _bot: unknown,
      _tabId: string | undefined,
      frame: (value: { src: string; title: string; url: string }) => void,
    ) => {
      frame({
        src: "data:image/jpeg;base64,ZmFrZQ==",
        title: "Resultados de Lisboa",
        url: "https://travel.example.test/reset/invite-Q7z8k2fR?token=fixture-token",
      })

      return () => {}
    },
  ),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  clearBrowserHold("bot-mark", "browser-tab")
  setInlinePreviewPreference(true)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

test("the browser working chip exposes a stop control", () => {
  const onStop = vi.fn()
  render(<BrowserWorkingStatus name="Lia" onStop={onStop} />)

  expect(screen.getByRole("status")).toHaveTextContent("Lia está trabalhando · No navegador")
  fireEvent.click(screen.getByRole("button", { name: "Parar Lia" }))
  expect(onStop).toHaveBeenCalledOnce()
})

const tab = {
  tabId: "browser-tab",
  ownerBotId: "bot-mark",
  url: "https://travel.example.test",
  title: "Resultados de Lisboa",
  state: "live",
  openerTabId: null,
  heldByUser: false,
  takeoverRequested: false,
  lastUsedAt: 10,
} satisfies BrowserTabInfo & { ownerBotId: string | null }

const getPart = (input: Partial<ToolCallPart> & Pick<ToolCallPart, "callId" | "tool" | "inputJson">): ToolCallPart => ({
  type: "tool_call",
  summary: "browser action",
  outputJson: null,
  ok: true,
  ...input,
})

const renderCard = (
  parts: ToolCallPart[],
  finished: boolean,
  getTabs = async () => ({ tabs: [tab] }),
  machine: Bot["machine"] = "local",
  waitingForPerson = false,
  locale: Locale = "pt-BR",
) => {
  const api = createMockApi()
  let sessionHeld: boolean | undefined
  const request = vi.fn(async (route: string) => {
    if (route === "GET /browser/tabs") {
      const result = await getTabs()
      return sessionHeld === undefined
        ? result
        : { tabs: result.tabs.map((tab) => ({ ...tab, heldByUser: sessionHeld })) }
    }
    if (route === "DELETE /browser/tabs/:id/takeover/session") {
      sessionHeld = false
      return {}
    }
    if (route === "POST /browser/tabs/:id/takeover/session") {
      sessionHeld = true
      return { sessionId: "synthetic-session", controlEpoch: "synthetic-control-epoch", viewEpoch: 0 }
    }
    if (route === "POST /browser/tabs/:id/takeover/frame")
      return {
        controlEpoch: "synthetic-control-epoch",
        targetEpoch: 1,
        viewEpoch: 0,
        title: "Página de teste",
        url: "https://exemplo.test/pesquisa",
        image: "data:image/png;base64,ZmFrZQ==",
        width: 1280,
        height: 720,
      }
    if (route === "GET /attachments/:id/content")
      return {
        text: JSON.stringify({
          title: "Resultados de Lisboa",
          url: "https://person:fixture-password@travel.example.test?token=fixture-token",
          content: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
        }),
        offset: 0,
        nextOffset: null,
        bytes: 64,
      }

    return {}
  }) as ApiRequest
  api.request = request
  const storedBot = api.getState().bots[0] ?? null
  const bot = storedBot ? { ...storedBot, machine } : null
  const onOpenComputer = vi.fn()
  const view = render(
    <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
      <BrowserActivityCard
        parts={parts}
        finished={finished}
        waitingForPerson={waitingForPerson}
        createdAt={1}
        threadId="thread-mark"
        botName="Lia"
        locale={locale}
      />
    </InlinePreviewContext.Provider>,
  )

  return { api, bot, onOpenComputer, request, view }
}

test("shows live browser steps and keeps typed values and URL credentials and queries out of the card", async () => {
  const parts = [
    getPart({
      callId: "open",
      tool: "mcp__touri__browser_open",
      inputJson: '{"url":"https://travel.example.test/search"}',
    }),
    getPart({
      callId: "type",
      tool: "mcp__touri__browser_type",
      startedAt: 20,
      inputJson:
        '{"tabId":"browser-tab","target":{"kind":"role","role":"textbox","name":"Destination"},"text":"private search value"}',
    }),
    getPart({
      callId: "click",
      tool: "mcp__touri__browser_click",
      startedAt: 30,
      inputJson: '{"tabId":"browser-tab","target":{"kind":"role","role":"option","name":"Lisboa, Portugal"}}',
    }),
  ]

  renderCard(parts, false)

  expect(screen.getByText("Navegador do Lia")).toBeVisible()
  expect(screen.getByText("Preencheu um campo")).toBeVisible()
  expect(screen.getByText("Clicou em Lisboa, Portugal")).toBeVisible()
  expect(screen.getByText("O bot está usando o navegador.")).toBeVisible()
  expect(screen.getByRole("progressbar", { name: "Progresso do navegador" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Ampliar tela do navegador" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Recolher cartão do navegador" })).toBeVisible()
  expect(document.querySelector(".browser-activity-checklist")).toBeNull()
  await waitFor(() => expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible())
  expect(document.body.textContent).not.toContain("private search value")
  expect(document.body.textContent).not.toContain("person@example.test")
  expect(document.body.textContent).not.toContain("private-password")
  expect(screen.getAllByText(/travel\.example\.test/)).toHaveLength(1)
  expect(document.body.textContent).not.toContain("https://travel.example.test")
  expect(document.body.textContent).not.toContain("invite-Q7z8k2fR")
  expect(document.body.textContent).not.toContain("fixture-token")
})

test.each<Locale>(["pt-BR", "en"])(
  "a live card has one take-over control before and during a pause in %s",
  async (locale) => {
    const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: '{"tabId":"browser-tab"}' })]
    const { api } = renderCard(parts, false, undefined, "local", false, locale)
    const card = screen.getByRole("article", { name: t("Browser for {name}", { name: "Lia" }, locale) })
    const controls = within(card)
    const takeoverName = new RegExp(t("Take over browser", {}, locale))

    await waitFor(() => expect(controls.getAllByRole("button", { name: takeoverName })).toHaveLength(1))
    expect(controls.getByRole("button", { name: takeoverName })).toBeEnabled()
    expect(controls.getByRole("button", { name: takeoverName }).closest("header")).not.toBeNull()
    expect(controls.getByRole("img", { name: t("Current browser page", {}, locale) })).toBeVisible()

    act(() =>
      api.emit({
        type: "browser.tab",
        tab: Object.assign({}, tab, { heldByUser: true, takeoverReason: "login" as const }),
      }),
    )

    expect(controls.getAllByRole("button", { name: takeoverName })).toHaveLength(1)
    expect(controls.getByRole("button", { name: takeoverName })).toBeEnabled()
    expect(controls.getByRole("img", { name: t("Current browser page", {}, locale) })).toBeVisible()
  },
)

test("collapsing a live card stops its preview source until the card is expanded", async () => {
  const stopPreview = vi.fn()
  vi.mocked(startInlineFrameSource).mockReturnValueOnce(stopPreview)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  await waitFor(() => expect(startInlineFrameSource).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole("button", { name: "Recolher cartão do navegador" }))

  await waitFor(() => expect(stopPreview).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole("button", { name: "Expandir cartão do navegador" }))

  await waitFor(() => expect(startInlineFrameSource).toHaveBeenCalledTimes(2))
})

test("handback restarts the live preview after the remote control source takes over", async () => {
  const stopPreview = Object.assign(vi.fn(), { refresh: vi.fn() })
  vi.mocked(startInlineFrameSource).mockImplementationOnce((_api, _bot, _tabId, frame) => {
    frame({ src: "data:image/jpeg;base64,cHJldmlldw==", title: "Página fictícia", url: "https://travel.example.test" })
    return stopPreview
  })
  const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: '{"tabId":"browser-tab"}' })]
  renderCard(parts, false)
  const preview = await screen.findByRole("img", { name: "Página atual do navegador" })
  expect(preview).toHaveAttribute("src", "data:image/jpeg;base64,cHJldmlldw==")

  fireEvent.click(screen.getByRole("button", { name: "Assumir", exact: true }))

  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
  expect(stopPreview).toHaveBeenCalledOnce()

  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() => expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull())
  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Página atual do navegador" })).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,ZmFrZQ==",
    ),
  )
  expect(startInlineFrameSource).toHaveBeenCalledTimes(2)
  expect(screen.getByRole("button", { name: "Assumir", exact: true })).toBeEnabled()
})

test("handback waits for a fresh frame instead of showing the page from before takeover", async () => {
  const replacement = Promise.withResolvers<Parameters<typeof startInlineFrameSource>[3]>()
  vi.mocked(startInlineFrameSource)
    .mockImplementationOnce((_api, _bot, _tabId, frame) => {
      frame({ src: "data:image/jpeg;base64,b2xk", title: "Anterior", url: "https://travel.example.test" })

      return () => {}
    })
    .mockImplementationOnce((_api, _bot, _tabId, frame) => {
      replacement.resolve(frame)

      return () => {}
    })
  const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: '{"tabId":"browser-tab"}' })]
  renderCard(parts, false)
  await screen.findByRole("img", { name: "Página atual do navegador" })
  fireEvent.click(screen.getByRole("button", { name: "Assumir", exact: true }))
  await screen.findByRole("region", { name: "Controle remoto do navegador" })

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))
  })
  const receiveFrame = await replacement.promise

  expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  act(() => {
    receiveFrame({ src: "data:image/jpeg;base64,bmV3", title: "Atual", url: "https://travel.example.test" })
  })
  expect(screen.getByRole("img", { name: "Página atual do navegador" })).toHaveAttribute(
    "src",
    "data:image/jpeg;base64,bmV3",
  )
})

test("the activity log is keyboard-accessible and disclosure controls reference mounted content", () => {
  const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: "{}" })]

  renderCard(parts, false)

  const disclosure = screen.getByRole("button", { name: "Recolher cartão do navegador" })
  const log = screen.getByRole("log", { name: "Atividade do navegador" })
  expect(log).toHaveAttribute("tabindex", "0")
  expect(disclosure).toHaveAttribute("aria-controls", log.parentElement?.id)

  fireEvent.click(disclosure)

  expect(disclosure).not.toHaveAttribute("aria-controls")
  expect(screen.queryByRole("log", { name: "Atividade do navegador" })).toBeNull()
})

test.each<{
  locale: Locale
  expandView: string
  collapseView: string
  expandCard: string
  collapseCard: string
}>([
  {
    locale: "pt-BR",
    expandView: "Ampliar tela do navegador",
    collapseView: "Reduzir tela do navegador",
    expandCard: "Expandir cartão do navegador",
    collapseCard: "Recolher cartão do navegador",
  },
  {
    locale: "en",
    expandView: "Expand browser view",
    collapseView: "Collapse browser view",
    expandCard: "Expand browser card",
    collapseCard: "Collapse browser card",
  },
])("browser toggles announce their next action once in $locale", async (copy) => {
  const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: '{"tabId":"browser-tab"}' })]
  renderCard(parts, false, undefined, "local", false, copy.locale)
  const viewToggle = screen.getByRole("button", { name: copy.expandView })
  await waitFor(() => expect(viewToggle).toBeEnabled())

  fireEvent.click(viewToggle)

  expect(screen.getByRole("button", { name: copy.collapseView })).toBe(viewToggle)
  expect(viewToggle).not.toHaveAttribute("aria-pressed")
  expect(viewToggle).not.toHaveAttribute("aria-expanded")
  expect(document.querySelector(".browser-activity-preview")).toHaveClass("browser-activity-preview-full")

  fireEvent.click(viewToggle)

  expect(viewToggle).toHaveAccessibleName(copy.expandView)
  expect(document.querySelector(".browser-activity-preview")).not.toHaveClass("browser-activity-preview-full")
  const cardToggle = screen.getByRole("button", { name: copy.collapseCard })
  expect(cardToggle).not.toHaveAttribute("aria-expanded")
  expect(cardToggle).toHaveAttribute("aria-controls")

  fireEvent.click(cardToggle)

  expect(cardToggle).toHaveAccessibleName(copy.expandCard)
  expect(cardToggle).not.toHaveAttribute("aria-expanded")
  expect(cardToggle).not.toHaveAttribute("aria-controls")

  fireEvent.click(cardToggle)

  expect(cardToggle).toHaveAccessibleName(copy.collapseCard)
  expect(cardToggle).not.toHaveAttribute("aria-expanded")
  expect(cardToggle).toHaveAttribute("aria-controls")
})

test.each([
  {
    action: "click",
    current: ["Clicking an element", "Clicando em um elemento"],
    completed: ["Clicked an element", "Clicou em um elemento"],
  },
  {
    action: "list_tabs",
    current: ["Switching tabs", "Trocando de aba"],
    completed: ["Switched tabs", "Trocou de aba"],
  },
  {
    action: "switch_tab",
    current: ["Switching tabs", "Trocando de aba"],
    completed: ["Switched tabs", "Trocou de aba"],
  },
  {
    action: "scroll",
    current: ["Scrolling the page", "Rolando a página"],
    completed: ["Scrolled the page", "Rolou a página"],
  },
  {
    action: "wait_for",
    current: ["Waiting for the page", "Aguardando a página"],
    completed: ["Waited for the page", "Aguardou a página"],
  },
])(
  "browser $action copy describes the live and completed action in both languages",
  ({ action, current, completed }) => {
    const part = getPart({ callId: "action", tool: `browser_${action}`, inputJson: "{}" })
    const pending = Object.assign({}, part, { ok: null })

    const currentLabels = [
      getBrowserActivityCurrentLabel(pending, "en"),
      getBrowserActivityCurrentLabel(pending, "pt-BR"),
    ]
    const completedLabels = [getBrowserActivityLabel(part, "en"), getBrowserActivityLabel(part, "pt-BR")]

    expect(currentLabels).toEqual(current)
    expect(completedLabels).toEqual(completed)
  },
)

test("a completed card only controls its history after the disclosure is open", () => {
  const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: "{}" })]

  renderCard(parts, true)

  const summary = screen.getByRole("button", { name: /Ver as etapas/ })
  expect(summary).toHaveAttribute("aria-expanded", "false")
  expect(summary).not.toHaveAttribute("aria-controls")

  fireEvent.click(summary)

  expect(summary).toHaveAttribute("aria-expanded", "true")
  const contentId = summary.getAttribute("aria-controls")
  expect(contentId).toBeTruthy()
  expect(document.getElementById(contentId ?? "")).toBeVisible()
})

test("sanitizes a takeover reason before showing it", () => {
  const part = getPart({
    callId: "takeover",
    tool: "mcp__touri__browser_request_takeover",
    inputJson: JSON.stringify({ reason: "Confirm with fixture@example.test at 2025550142" }),
  })

  expect(getBrowserTakeoverReason([part])).toBe("Confirm with [email] at [number]")
})

test("keeps the bot's whole handoff reason instead of cutting it mid-word", () => {
  const reason = "Validação do touri: teste clique, rolagem e digitação nesta aba da página de teste local"
  const long = `Confira a página de exemplo e ${"conclua a etapa de verificação ".repeat(12)}`
  const getReason = (value: string) =>
    getBrowserTakeoverReason([
      getPart({ callId: "takeover", tool: "browser_request_takeover", inputJson: JSON.stringify({ reason: value }) }),
    ])

  const shortened = getReason(long) ?? ""

  expect(getReason(reason)).toBe(reason)
  expect(shortened).toMatch(/…$/)
  expect(shortened.length).toBeLessThanOrEqual(240)
  expect(long.startsWith(`${shortened.slice(0, -1)} `)).toBe(true)
})

test("shows one sanitized browser URL in the address bar", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  const domain = await screen.findByText("travel.example.test")

  expect(domain).toBeVisible()
  expect(domain.closest(".browser-activity-chrome")).toHaveTextContent("travel.example.test")
  expect(screen.getAllByText(/travel\.example\.test/)).toHaveLength(1)
  expect(screen.queryByRole("group", { name: "Endereço do navegador" })).toBeNull()
})

test("marks completed and current browser actions with their progress state", () => {
  const parts = [
    getPart({ callId: "open", tool: "browser_open", inputJson: "{}", ok: true }),
    getPart({ callId: "click", tool: "browser_click", inputJson: "{}", ok: null }),
  ]

  renderCard(parts, false)

  const rows = screen.getByRole("log", { name: "Atividade do navegador" }).querySelectorAll("li")
  expect(rows[0]).toHaveAttribute("data-status", "complete")
  expect(rows[1]).toHaveAttribute("data-status", "in-progress")
  expect(within(rows[1] as HTMLElement).getByLabelText("Em andamento")).toBeVisible()
})

test("lets a phone reader expand the compact browser action list", () => {
  const parts = [
    getPart({ callId: "open", tool: "browser_open", inputJson: "{}" }),
    getPart({ callId: "read", tool: "browser_snapshot", inputJson: "{}" }),
    getPart({ callId: "click", tool: "browser_click", inputJson: "{}" }),
    getPart({ callId: "fill", tool: "browser_type", inputJson: "{}" }),
    getPart({ callId: "shot", tool: "browser_screenshot", inputJson: "{}" }),
  ]

  renderCard(parts, false)

  const showAll = screen.getByRole("button", { name: "Ver tudo", hidden: true })
  expect(showAll).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(showAll)
  expect(showAll).toHaveAttribute("aria-expanded", "true")
})

test.each<{ locale: Locale; screenshot: string; steps: string }>([
  { locale: "pt-BR", screenshot: "Print final do navegador", steps: "Ver as etapas" },
  { locale: "en", screenshot: "Final browser screenshot", steps: "See the steps" },
])(
  "the finished browser summary localizes its screenshot and steps in $locale",
  async ({ locale, screenshot, steps }) => {
    const parts = [
      getPart({
        callId: "screenshot",
        tool: "browser_screenshot",
        inputJson: "{}",
        outputAttachmentId: "final-shot",
        outputBytes: 64,
        outputPreview: "",
      }),
    ]

    renderCard(parts, true, undefined, "local", false, locale)

    expect(await screen.findByText("Resultados de Lisboa", { exact: false })).toBeVisible()
    expect(screen.getByRole("img", { name: screenshot })).toBeVisible()
    expect(screen.getByRole("button", { name: /Used the browser|Usou o navegador/ })).toHaveTextContent(steps)
  },
)

test("the composer takeover action opens the active browser session", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "GET /browser/tabs") return { tabs: [tab] }
    if (route === "POST /browser/tabs/:id/takeover/session")
      return { sessionId: "synthetic-session", controlEpoch: "synthetic-control-epoch", viewEpoch: 0 }
    return {}
  }) as ApiRequest
  api.request = request
  const storedBot = api.getState().bots[0] ?? null
  const bot = storedBot ? { ...storedBot, machine: "local" as const } : null

  render(
    <BrowserActivityControlsProvider>
      <ChannelComposerChip botName="Lia" />
      <InlinePreviewContext.Provider
        value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer: vi.fn() }}
      >
        <BrowserActivityCard parts={parts} finished={false} createdAt={1} botName="Lia" />
      </InlinePreviewContext.Provider>
    </BrowserActivityControlsProvider>,
  )

  const takeOver = await waitFor(() => {
    const status = document.querySelector(".composer-browser-status")
    if (!status) throw new Error("Browser status chip is missing")
    return within(status).getByRole("button", { name: "Assumir" })
  })
  fireEvent.click(takeOver)

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "browser-tab" }),
  )
  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
})

test("take-over holds the browser, opens its view, and the finished card collapses with the final image", async () => {
  const parts = [
    getPart({ callId: "open", tool: "mcp__touri__browser_open", inputJson: '{"tabId":"browser-tab"}' }),
    getPart({ callId: "read", tool: "mcp__touri__browser_snapshot", inputJson: '{"tabId":"browser-tab"}' }),
    getPart({
      callId: "screenshot",
      tool: "mcp__touri__browser_screenshot",
      inputJson: '{"tabId":"browser-tab"}',
      outputAttachmentId: "final-shot",
      outputBytes: 64,
      outputPreview: "",
    }),
  ]
  const { api, bot, onOpenComputer, request, view } = renderCard(parts, false)
  const takeOver = await screen.findByRole("button", { name: "Assumir" })

  fireEvent.click(takeOver)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "browser-tab" }),
  )
  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
  expect(onOpenComputer).not.toHaveBeenCalled()

  view.rerender(
    <InlinePreviewContext.Provider
      value={{
        api,
        bot,
        machine: undefined,
        activeCallId: undefined,
        onOpenComputer,
      }}
    >
      <BrowserActivityCard parts={parts} finished createdAt={1} threadId="thread-mark" botName="Lia" />
    </InlinePreviewContext.Provider>,
  )

  expect(await screen.findByRole("button", { name: "Devolver para Lia" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))
  expect(screen.queryByText("Usou o navegador · 3 ações")).toBeNull()
  await waitFor(() => expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull())
  const resumedRun = {
    id: "resumed",
    botId: bot?.id,
    threadId: "thread-mark",
    trigger: "retry",
    status: "running",
  } as Run
  act(() => api.emit({ type: "run.updated", run: resumedRun }))
  act(() => api.emit({ type: "run.updated", run: { ...resumedRun, status: "succeeded" } }))
  expect(await screen.findByText("Usou o navegador · 3 ações")).toBeVisible()
  expect(screen.getByText("Ver as etapas")).toBeVisible()
  expect(screen.getByRole("img", { name: "Print final do navegador" })).toBeVisible()
  await waitFor(() => expect(screen.queryByText("Atividade do navegador")).toBeNull())
  fireEvent.click(screen.getByRole("button", { name: /Usou o navegador/ }))
  expect(await screen.findByText("Atividade do navegador")).toBeVisible()
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("GET /attachments/:id/content", expect.anything(), { id: "final-shot" }),
  )
  expect(document.body.textContent).not.toContain("fixture-password")
  expect(document.body.textContent).not.toContain("fixture-token")
})

test.each(["running", "succeeded"] as const)(
  "handback observes a continuation that is %s before the release response",
  async (status) => {
    const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
    const { api, bot, request, view, onOpenComputer } = renderCard(parts, false)
    fireEvent.click(await screen.findByRole("button", { name: "Assumir" }))
    expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
    view.rerender(
      <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
        <BrowserActivityCard parts={parts} finished createdAt={1} threadId="thread-mark" botName="Lia" />
      </InlinePreviewContext.Provider>,
    )
    const release = Promise.withResolvers<void>()
    const releasing = Promise.withResolvers<void>()
    const originalRequest = request.getMockImplementation()
    const continuation = {
      id: "handback-continuation",
      botId: bot?.id,
      threadId: "thread-mark",
      trigger: "retry",
      status: "running",
    } as Run
    request.mockImplementation(async (...args) => {
      const response = await originalRequest?.(...args)
      if (args[0] !== "DELETE /browser/tabs/:id/takeover/session") return response
      releasing.resolve()
      await release.promise
      return response
    })

    fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))
    await act(async () => releasing.promise)
    act(() => {
      const unrelated = [
        Object.assign({}, continuation, { id: "other-bot", botId: "bot-other" }),
        Object.assign({}, continuation, { id: "other-thread", threadId: "thread-other" }),
      ]
      unrelated.forEach((run) => {
        api.emit({ type: "run.updated", run })
        api.emit({ type: "run.updated", run: Object.assign({}, run, { status: "succeeded" }) })
      })
      api.emit({ type: "run.updated", run: continuation })
      if (status === "succeeded") api.emit({ type: "run.updated", run: Object.assign({}, continuation, { status }) })
    })
    await act(async () => release.resolve())
    if (status === "running") {
      expect(screen.queryByText("Usou o navegador · 1 ação")).toBeNull()
      act(() => api.emit({ type: "run.updated", run: Object.assign({}, continuation, { status: "succeeded" }) }))
    }

    expect(screen.getByText("Usou o navegador · 1 ação")).toBeVisible()
    expect(screen.queryByRole("log", { name: "Atividade do navegador" })).toBeNull()
  },
)

test("a bot-requested takeover explains why it paused and keeps browser input out of chat", async () => {
  const heldTab = { ...tab, heldByUser: true, takeoverReason: "login" }
  const parts = [
    getPart({ callId: "read", tool: "mcp__touri__browser_snapshot", inputJson: '{"tabId":"browser-tab"}' }),
    getPart({
      callId: "login",
      tool: "mcp__touri__browser_click",
      startedAt: 30,
      inputJson: '{"tabId":"browser-tab","target":{"kind":"role","role":"button","name":"Sign in"}}',
    }),
  ]
  const { request } = renderCard(parts, false, async () => ({ tabs: [heldTab] }))

  expect(await screen.findByText("O site pediu login para continuar.")).toBeVisible()
  expect(screen.getByText("O site pediu login para continuar.")).toBeVisible()
  expect(screen.getByText("Últimas ações")).toBeVisible()
  expect(screen.getByText("Leu a página")).toBeVisible()
  expect(screen.getByRole("button", { name: "Assumir" })).toBeVisible()
  expect(screen.queryByRole("textbox")).toBeNull()
  expect(request).not.toHaveBeenCalledWith("POST /browser/tabs/:id/takeover", expect.anything(), { id: "browser-tab" })
})

test("a VM browser opens the interactive remote takeover session in the transcript", async () => {
  const parts = [
    getPart({
      callId: "takeover",
      tool: "mcp__touri__browser_request_takeover",
      inputJson: '{"tabId":"browser-tab","reason":"O site pediu login para mostrar o preço final."}',
    }),
  ]
  const { onOpenComputer, request } = renderCard(parts, false, undefined, "vm")

  fireEvent.click(await screen.findByRole("button", { name: "Assumir" }))

  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
  expect(screen.getByText("O site pediu login para mostrar o preço final.")).toBeVisible()
  expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "browser-tab" })
  expect(request).not.toHaveBeenCalledWith("POST /browser/tabs/:id/takeover", expect.anything(), { id: "browser-tab" })
  expect(onOpenComputer).not.toHaveBeenCalled()
})

test("historical browser cards never sample or take over the current browser page", async () => {
  const parts = [getPart({ callId: "old", tool: "browser_open", inputJson: "{}" })]
  const { request } = renderCard(parts, true)

  fireEvent.click(screen.getByRole("button", { name: /Usou o navegador/ }))

  expect(screen.queryByRole("img", { name: "Print final do navegador" })).toBeNull()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull()
  expect(request).not.toHaveBeenCalledWith("GET /browser/tabs", expect.anything())
})

test("a persisted human pause keeps controls available before the held-tab event arrives", async () => {
  renderCard(
    [getPart({ callId: "pending-open", tool: "mcp__touri__browser_open", inputJson: '{"tabId":"browser-tab"}' })],
    true,
    undefined,
    "local",
    true,
  )

  expect(await screen.findByRole("button", { name: "Assumir" })).toBeVisible()
  expect(screen.queryByRole("button", { name: /Usou o navegador/ })).toBeNull()
})

test("a persisted human pause keeps sampling while its tab snapshot is delayed", async () => {
  const snapshot = Promise.withResolvers<{ tabs: Array<typeof tab> }>()
  renderCard(
    [getPart({ callId: "pending-login", tool: "browser_click", inputJson: '{"tabId":"browser-tab"}' })],
    true,
    () => snapshot.promise,
    "local",
    true,
  )

  expect(await screen.findByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  expect(startInlineFrameSource).toHaveBeenCalled()
  expect(screen.queryByRole("progressbar")).toBeNull()

  await act(async () => snapshot.resolve({ tabs: [] }))
})

test("a delayed human-pause projection expands a completed card before its tab arrives", async () => {
  const parts = [getPart({ callId: "pending-login", tool: "browser_click", inputJson: '{"tabId":"browser-tab"}' })]
  const snapshot = Promise.withResolvers<{ tabs: Array<typeof tab> }>()
  const { api, bot, view, onOpenComputer } = renderCard(parts, true, () => snapshot.promise)

  view.rerender(
    <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
      <BrowserActivityCard parts={parts} finished waitingForPerson createdAt={1} botName="Lia" />
    </InlinePreviewContext.Provider>,
  )

  expect(await screen.findByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  expect(screen.getByText("O site pediu sua confirmação antes de continuar.")).toBeVisible()
  expect(startInlineFrameSource).toHaveBeenCalled()

  await act(async () => snapshot.resolve({ tabs: [] }))
})

test.each([
  ["login", "pt-BR", "O site pediu login para continuar."],
  ["login", "en", "The site asked you to sign in before continuing."],
  ["payment", "pt-BR", "O site pediu que você confira uma compra ou pagamento antes de continuar."],
  ["form_submit", "pt-BR", "O site pediu para enviar um formulário antes de continuar."],
  ["sensitive_action", "pt-BR", "O site pediu sua confirmação antes de continuar."],
] as const)("takeover reason %s uses plain language in %s", async (reason, locale, copy) => {
  renderCard(
    [
      getPart({
        callId: "takeover",
        tool: "browser_request_takeover",
        inputJson: JSON.stringify({ tabId: "browser-tab", reason }),
      }),
    ],
    true,
    async () => ({ tabs: [{ ...tab, heldByUser: true, takeoverRequested: true }] }),
    "local",
    true,
    locale,
  )

  fireEvent.click(await screen.findByRole("button", { name: t("Take over browser", {}, locale) }))

  const control = await screen.findByRole("region", { name: t("Remote browser control", {}, locale) })
  expect(within(control).getByText(copy)).toBeVisible()
  expect(within(control).queryByText(reason, { exact: true })).toBeNull()
})

test("a completed provider turn keeps a pending human handoff available", async () => {
  const requestedTab = { ...tab, heldByUser: true, takeoverRequested: true }
  const parts = [
    getPart({
      callId: "takeover",
      tool: "mcp__touri__browser_request_takeover",
      inputJson: '{"tabId":"browser-tab","reason":"login"}',
    }),
  ]

  renderCard(parts, true, async () => ({ tabs: [requestedTab] }))

  expect(await screen.findByRole("button", { name: "Assumir" })).toBeVisible()
  expect(screen.queryByText("https://travel.example.test/results")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Assumir" }))
  expect(await screen.findByRole("button", { name: "Devolver para Lia" })).toBeVisible()
})

test("a newly opened output tab takes precedence over an older input tab", () => {
  const parts = [
    getPart({ callId: "old", tool: "browser_snapshot", inputJson: '{"tabId":"old-tab"}' }),
    getPart({ callId: "new", tool: "browser_open", inputJson: "{}", outputJson: '{"structured":{"tabId":"new-tab"}}' }),
  ]

  expect(getBrowserActivityTabId(parts)).toBe("new-tab")
})

test.each([
  [
    "TOURI_BROWSER_DECISION_HINT|missing_key",
    "A ajuda nas escolhas está desativada ou sem chave salva. Você pode ativá-la em Modelos por API. O navegador continuará funcionando.",
  ],
  [
    "TOURI_BROWSER_DECISION_HINT|no_credit",
    "O assistente do navegador está sem crédito. Continuando com os controles padrão.",
  ],
  [
    "TOURI_BROWSER_DECISION_HINT|unavailable",
    "O assistente do navegador está indisponível. Continuando com os controles padrão.",
  ],
  [
    "TOURI_BROWSER_TAKEOVER_REQUIRED|form_submit",
    "Esta ação precisa de você. Assuma o controle da aba para continuar.",
  ],
  [
    "TOURI_BROWSER_DECISION_QUESTION|{}",
    "Não foi possível escolher com segurança. Assuma o controle da aba para escolher.",
  ],
])("keeps the browser notice visible without echoing raw output: %s", (marker, notice) => {
  const parts = [
    getPart({
      callId: "choice",
      tool: "browser_click",
      inputJson: '{"tabId":"browser-tab"}',
      outputJson: JSON.stringify({ content: [{ type: "text", text: `${marker}\nprivate-provider-detail` }] }),
    }),
  ]

  renderCard(parts, false)

  expect(screen.getByText(notice)).toBeVisible()
  expect(screen.getByRole("log", { name: "Atividade do navegador" })).toHaveAttribute("aria-live", "polite")
  expect(document.body.textContent).not.toContain("private-provider-detail")
  expect(document.body.textContent).not.toContain("TOURI_BROWSER_")
})

test("shows the needs-you notice for a waiting browser action", () => {
  const part = getPart({
    callId: "waiting",
    tool: "browser_click",
    inputJson: '{"tabId":"browser-tab"}',
    outputJson: JSON.stringify({ structured: { status: "waiting_for_person" } }),
  })

  renderCard([part], false)

  expect(screen.getByText("Esta ação precisa de você. Assuma o controle da aba para continuar.")).toBeVisible()
})

test("failed actions never appear as successful clicks", () => {
  const parts = [
    getPart({
      callId: "failed",
      tool: "browser_click",
      inputJson: "{}",
      ok: false,
      outputJson: "private-provider-detail",
    }),
  ]

  renderCard(parts, false)

  expect(screen.getByText("A ação no navegador não terminou. Conferindo a página.")).toBeVisible()
  expect(screen.queryByText("Clicou em um elemento")).toBeNull()
  expect(document.body.textContent).not.toContain("private-provider-detail")
})

test("an attached open result resets the old tab until metadata resolves the new page", () => {
  const parts = [
    getPart({ callId: "old", tool: "browser_snapshot", inputJson: '{"tabId":"old-tab"}' }),
    getPart({ callId: "new", tool: "browser_open", inputJson: "{}", outputAttachmentId: "open-result" }),
  ]

  expect(getBrowserActivityTabId(parts)).toBeUndefined()
})

test("browser notices are translated into English without provider details", () => {
  const part = getPart({
    callId: "notice",
    tool: "browser_click",
    inputJson: "{}",
    outputJson: "TOURI_BROWSER_DECISION_HINT|no_credit",
  })

  expect(getBrowserActivityNotice(part, "en")).toBe(
    "The browser helper has no credit. Continuing with standard controls.",
  )
})

test.each(["file:///workspace/private.txt", "javascript:alert(1)", "data:text/plain,private"])(
  "never displays non-web preview URLs: %s",
  (url) => {
    expect(getBrowserActivityUrl(url)).toBe("")
  },
)

test.each([
  "https://travel.example.test/reset/invite-Q7z8k2fR",
  "https://travel.example.test/auth/9b0d9f4a5e7c",
  "https://travel.example.test/confirm/opaque-token?next=%2Faccount",
])("only displays the origin when a browser URL contains a private path: %s", (url) => {
  expect(getBrowserActivityUrl(url)).toBe("https://travel.example.test")
})

test("a delayed tab snapshot cannot undo a newer takeover event", async () => {
  let resolveTabs: (value: { tabs: (typeof tab)[] }) => void = () => {}
  const tabs = new Promise<{ tabs: (typeof tab)[] }>((resolve) => {
    resolveTabs = resolve
  })
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const { api } = renderCard(parts, false, () => tabs)

  act(() => api.emit({ type: "browser.tab", tab: { ...tab, heldByUser: true } }))
  await act(async () => {
    resolveTabs({ tabs: [tab] })
    await tabs
  })

  expect(document.querySelector(".browser-activity-card")).toHaveAttribute("data-held", "true")
  expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
})

test("disabling live chat previews prevents capture and leaves browser control available", () => {
  setInlinePreviewPreference(false)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  expect(startInlineFrameSource).not.toHaveBeenCalled()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Ampliar tela do navegador" })).toBeNull()
  expect(screen.getByText("Atividade do navegador")).toBeVisible()
  expect(screen.getByRole("button", { name: "Assumir" })).toBeVisible()
})

test("live browser thumbnails sample every 700 ms and pause while the card is offscreen", async () => {
  const visibilityUpdates: Array<(visible: boolean) => void> = []
  const stop = vi.fn()
  class PreviewObserver {
    constructor(callback: IntersectionObserverCallback) {
      visibilityUpdates.push((visible) =>
        callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      )
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", PreviewObserver)
  vi.mocked(startInlineFrameSource).mockReturnValueOnce(stop)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)
  act(() => visibilityUpdates[0]?.(true))
  await waitFor(() => expect(startInlineFrameSource).toHaveBeenCalledOnce())

  expect(vi.mocked(startInlineFrameSource).mock.calls[0]?.[6]).toEqual({
    intervalMs: 700,
    onReset: expect.any(Function),
  })

  act(() => visibilityUpdates[0]?.(false))
  await waitFor(() => expect(stop).toHaveBeenCalledOnce())
})

test("an attached new page never borrows the previous tab while its metadata is loading", async () => {
  let resolveTabs: (value: { tabs: (typeof tab)[] }) => void = () => {}
  const nextTabs = new Promise<{ tabs: (typeof tab)[] }>((resolve) => {
    resolveTabs = resolve
  })
  const getTabs = vi
    .fn()
    .mockResolvedValueOnce({ tabs: [tab] })
    .mockReturnValueOnce(nextTabs)
  const oldPage = getPart({ callId: "old-page", tool: "browser_open", inputJson: "{}" })
  const { api, bot, onOpenComputer, request, view } = renderCard([oldPage], false, getTabs)
  await screen.findByRole("button", { name: "Assumir" })
  const newPage = getPart({
    callId: "new-page",
    tool: "browser_open",
    inputJson: "{}",
    outputAttachmentId: "new-page-result",
  })

  view.rerender(
    <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
      <BrowserActivityCard
        parts={[oldPage, newPage]}
        finished={false}
        createdAt={1}
        threadId="thread-mark"
        botName="Lia"
      />
    </InlinePreviewContext.Provider>,
  )

  expect(screen.getByRole("button", { name: "Assumir" })).toBeDisabled()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()

  await act(async () => {
    resolveTabs({ tabs: [{ ...tab, tabId: "new-tab" }] })
    await nextTabs
  })
  fireEvent.click(screen.getByRole("button", { name: "Assumir" }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "new-tab" }),
  )
})

test("take-over keeps the inline frame and sampling while explaining why the bot paused", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const stop = vi.fn()
  vi.mocked(startInlineFrameSource).mockImplementationOnce((_api, _bot, _tabId, frame) => {
    frame({ src: "data:image/jpeg;base64,ZmFrZQ==", title: "Resultados", url: "https://travel.example.test" })

    return () => stop()
  })
  const { api } = renderCard(parts, false)
  await waitFor(() => expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible())

  act(() => api.emit({ type: "browser.tab", tab: { ...tab, heldByUser: true } }))

  expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  expect(screen.getByText("O navegador está pronto para você assumir.")).toBeVisible()
  expect(startInlineFrameSource).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
})

test("the composer chip switches to take-over and returns control", () => {
  const release = vi.fn()
  setBrowserHold("bot-mark", { tabId: "browser-tab", release })
  render(<BrowserWorkingStatus name="Lia" botId="bot-mark" onStop={vi.fn()} />)

  expect(screen.getByRole("status")).toHaveTextContent("Você está no controle · Lia pausado")
  fireEvent.click(screen.getByRole("button", { name: "Devolver" }))
  expect(release).toHaveBeenCalledOnce()
  act(() => clearBrowserHold("bot-mark", "browser-tab"))
  expect(screen.getByRole("status")).toHaveTextContent("Lia está trabalhando · No navegador")
})

test("take-over waits for the browser tab and reports a stalled connection", async () => {
  vi.useFakeTimers()
  try {
    const parts = [
      getPart({ callId: "open", tool: "browser_open", inputJson: '{"url":"https://travel.example.test/"}' }),
    ]
    renderCard(parts, false, async () => ({ tabs: [] }))

    const takeOver = screen.getByRole("button", { name: "Assumir" })
    expect(takeOver).toBeDisabled()
    expect(takeOver).toHaveAttribute("title", "Preparando o navegador…")
    expect(screen.getByText("Preparando o navegador…")).toBeVisible()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(
      screen.getByText("O navegador não enviou a prévia no prazo. Tente carregar a prévia novamente ou pare a tarefa."),
    ).toBeVisible()
  } finally {
    vi.useRealTimers()
  }
})

test("keeps polling until the browser tab resolves", async () => {
  const getTabs = vi
    .fn()
    .mockResolvedValueOnce({ tabs: [] })
    .mockResolvedValue({ tabs: [tab] })
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: "{}" })]
  renderCard(parts, false, getTabs)

  expect(screen.getByRole("button", { name: "Assumir" })).toBeDisabled()
  await waitFor(() => expect(screen.getByRole("button", { name: "Assumir" })).toBeEnabled(), { timeout: 5_000 })
})

test("does not offer an older bot tab while a new browser opening is pending", async () => {
  const parts = [
    getPart({
      callId: "pending-open",
      tool: "browser_open",
      inputJson: '{"url":"https://travel.example.test/new-search"}',
      ok: null,
    }),
  ]
  renderCard(parts, false)

  await act(async () => {})

  expect(screen.getByRole("button", { name: "Assumir" })).toBeDisabled()
  expect(startInlineFrameSource).not.toHaveBeenCalled()
})

test("highlights the running step and shows one sanitized URL in the address bar", () => {
  const parts = [
    getPart({ callId: "open", tool: "browser_open", startedAt: 9_999_999_999_000, inputJson: "{}" }),
    getPart({ callId: "fill", tool: "browser_type", startedAt: 20, ok: null, inputJson: '{"tabId":"browser-tab"}' }),
  ]

  renderCard(parts, false)

  const rows = document.querySelectorAll(".browser-activity-log li")
  expect(rows[1]).toHaveAttribute("data-current", "true")
  expect(rows[1]).toHaveAttribute("data-running", "true")
  expect(rows[0]).toHaveAttribute("data-current", "false")
  expect(screen.getByText("Abriu uma página")).toBeVisible()
  expect(screen.getByText("Preenchendo um campo")).toBeVisible()
  expect(screen.getByText("O bot está usando o navegador.")).toBeVisible()
  expect(document.querySelector(".browser-activity-url")).toBeNull()
  expect(document.body.textContent?.match(/travel\.example\.test/g)).toHaveLength(1)
  expect(document.body.textContent).not.toContain("invite-Q7z8k2fR")
})

test("browser action times stay ordered when tool completions arrive late", () => {
  const parts = [
    getPart({ callId: "a", tool: "browser_open", startedAt: 3_000, inputJson: "{}" }),
    getPart({ callId: "b", tool: "browser_click", startedAt: 1_000, inputJson: "{}" }),
    getPart({ callId: "c", tool: "browser_click", inputJson: "{}" }),
  ]

  expect(getBrowserActivityTimestamps(parts, 2_000)).toEqual([1_000, 1_000, 2_000])
})

test("short browser URLs drop scheme, port and query, and target labels omit private values", () => {
  expect(getBrowserActivityShortUrl("http://127.0.0.1:45229/test/e2e/fixtures/travel-search.html?x=1")).toBe(
    "127.0.0.1",
  )
  expect(getBrowserActivityShortUrl("https://travel.example.test/")).toBe("travel.example.test")
  expect(getBrowserActivityShortUrl("file:///etc/passwd")).toBe("")
  const click = getPart({
    callId: "target",
    tool: "browser_click",
    inputJson: '{"target":{"kind":"role","role":"button","name":"Buscar"}}',
  })
  const email = getPart({
    callId: "email",
    tool: "browser_click",
    inputJson: '{"target":{"kind":"role","role":"button","name":"person@example.test"}}',
  })

  expect(getBrowserActivityLabel(click, "pt-BR")).toBe("Clicou em Buscar")
  expect(getBrowserActivityLabel(email, "pt-BR")).toBe("Clicou em um elemento")
})

test.each(["TARGET_CHANGED", "ENGINE_UNAVAILABLE", "DEADLINE_EXCEEDED"])(
  "technical browser failures never request human takeover: %s",
  (errorCode) => {
    const part = getPart({
      callId: "retry",
      tool: "browser_type",
      inputJson: "{}",
      outputJson: JSON.stringify({ errorCode }),
      ok: false,
    })

    const label = getBrowserActivityLabel(part, "pt-BR")

    expect(label).not.toContain("Assuma")
    expect(label).not.toContain(errorCode)
  },
)

test("a detached browser request stays waiting without previewing or controlling another request", async () => {
  const part = getPart({
    callId: "queued",
    tool: "browser_open",
    inputJson: "{}",
    outputJson: JSON.stringify({ structured: { status: "waiting_for_browser", requestRunId: "queued-run" } }),
  })
  const { request } = renderCard([part], true)

  expect(screen.getAllByText(/Aguardando o outro pedido/).length).toBeGreaterThan(0)
  expect(screen.getByRole("button", { name: "Assumir" })).toBeDisabled()
  expect(request).not.toHaveBeenCalledWith("GET /browser/tabs", expect.anything())
  expect(isBrowserRequestQueued([part], "queued-run")).toBe(true)
  expect(isBrowserRequestQueued([part], "continuation")).toBe(false)
})

test("browser login notifications use the interface language", () => {
  const body = "The site asked you to sign in. Return control to let the bot continue."

  expect(t(body, {}, "pt-BR")).toBe("O site pediu login. Devolva o controle para o bot continuar.")
  expect(t(body, {}, "en")).toBe(body)
})

test("reopening a completed manual handoff restores its controls", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(
    parts,
    true,
    async () => ({ tabs: [{ ...tab, heldByUser: true, takeoverRequested: true }] }),
    "local",
    true,
  )

  expect(await screen.findByRole("button", { name: "Assumir" })).toBeVisible()
  expect(await screen.findByText("O site pediu sua confirmação antes de continuar.")).toBeVisible()
  expect(screen.queryByText("Ver as etapas")).toBeNull()
})

test("an already completed continuation settles the handback without a live event", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const { api, bot, view, onOpenComputer } = renderCard(parts, false)
  fireEvent.click(await screen.findByRole("button", { name: "Assumir" }))
  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
  const getCard = (runId: string) => (
    <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
      <BrowserActivityCard parts={parts} finished createdAt={1} runId={runId} threadId="thread-mark" botName="Lia" />
    </InlinePreviewContext.Provider>
  )
  view.rerender(getCard("original"))
  fireEvent.click(await screen.findByRole("button", { name: "Devolver para Lia" }))
  await waitFor(() => expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull())

  view.rerender(getCard("continued"))

  expect(await screen.findByText("Usou o navegador · 1 ação")).toBeVisible()
})

test("a finished browser task without a screenshot keeps a compact disclosure and its action log", () => {
  const parts = [
    getPart({ callId: "read", tool: "mcp__touri__browser_snapshot", inputJson: '{"tabId":"browser-tab"}' }),
  ]

  const { view } = renderCard(parts, true)
  const summary = screen.getByRole("button", { name: /Usou o navegador/ })

  expect(summary).toHaveClass("browser-activity-summary-compact")
  expect(summary).toHaveTextContent("Ver as etapas")
  expect(view.container.querySelector(".browser-activity-thumbnail")).toBeNull()
  fireEvent.click(summary)
  expect(screen.getByRole("log", { name: "Atividade do navegador" })).toBeVisible()

  view.rerender(
    <BrowserActivityCard parts={parts} finished createdAt={1} threadId="thread-mark" botName="Lia" locale="en" />,
  )

  expect(screen.getByRole("button", { name: /Used the browser/ })).toHaveTextContent("See the steps")
})

test.each(["live", "unloaded", "closed"] as const)(
  "an engine release dismisses remote control for a %s tab without returning canceled work",
  async (state) => {
    const replacement = Promise.withResolvers<Parameters<typeof startInlineFrameSource>[3]>()
    vi.mocked(startInlineFrameSource)
      .mockImplementationOnce((_api, _bot, _tabId, frame) => {
        frame({ src: "data:image/jpeg;base64,b2xk", title: "Anterior", url: "https://travel.example.test" })

        return () => {}
      })
      .mockImplementationOnce((_api, _bot, _tabId, frame) => {
        replacement.resolve(frame)

        return () => {}
      })
    const parts = [getPart({ callId: "read", tool: "browser_snapshot", inputJson: '{"tabId":"browser-tab"}' })]
    const { api, request } = renderCard(parts, false)
    await screen.findByRole("img", { name: "Página atual do navegador" })
    fireEvent.click(await screen.findByRole("button", { name: "Assumir" }))
    expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()

    request.mockImplementation(async (route: string) => {
      if (route === "POST /browser/tabs/:id/takeover/frame")
        throw new ApiError(403, "Esta sessão de controle não está ativa.")
      if (route === "GET /browser/tabs") return { tabs: [Object.assign({}, tab, { state })] }
      return {}
    })
    act(() => api.emit({ type: "browser.tab", tab: Object.assign({}, tab, { state }) }))

    await waitFor(() => expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull())
    const receiveFrame = await replacement.promise

    expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
    expect(screen.getByRole("button", { name: "Assumir" })).toBeVisible()
    expect(request).not.toHaveBeenCalledWith("DELETE /browser/tabs/:id/takeover/session", expect.anything(), {
      id: "browser-tab",
    })
    act(() => {
      receiveFrame({ src: "data:image/jpeg;base64,bmV3", title: "Atual", url: "https://travel.example.test" })
    })
    expect(screen.getByRole("img", { name: "Página atual do navegador" })).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,bmV3",
    )
  },
)

test("a stalled preview stops reconnecting and offers an explicit retry", async () => {
  const stop = vi.fn()
  vi.mocked(startInlineFrameSource).mockImplementation(() => stop)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  vi.useFakeTimers()
  renderCard(parts, false)
  await act(async () => {
    await Promise.resolve()
  })
  expect(startInlineFrameSource).toHaveBeenCalled()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_100)
  })

  expect(screen.queryByText(/Tentando reconectar/)).toBeNull()
  expect(screen.getByText(/O navegador não enviou a prévia no prazo/)).toBeVisible()
  expect(stop).toHaveBeenCalled()
  const attempts = vi.mocked(startInlineFrameSource).mock.calls.length

  fireEvent.click(screen.getByRole("button", { name: "Tentar carregar prévia novamente" }))

  expect(startInlineFrameSource).toHaveBeenCalledTimes(attempts + 1)
  vi.useRealTimers()
  vi.mocked(startInlineFrameSource).mockReset()
})

test("a background tab starts its preview deadline only when the reader returns", async () => {
  const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(true)
  vi.mocked(startInlineFrameSource).mockReturnValue(() => {})
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  vi.useFakeTimers()
  renderCard(parts, false)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(16_000)
  })

  expect(screen.queryByRole("button", { name: "Tentar carregar prévia novamente" })).toBeNull()
  expect(startInlineFrameSource).not.toHaveBeenCalled()

  act(() => {
    visibility.mockReturnValue(false)
    document.dispatchEvent(new Event("visibilitychange"))
  })

  expect(startInlineFrameSource).toHaveBeenCalled()
  expect(screen.queryByText(/O navegador não enviou a prévia no prazo/)).toBeNull()
})

test("an unavailable session explains recovery without claiming browser control", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const { request } = renderCard(parts, false)
  await screen.findByRole("button", { name: "Assumir" })
  request.mockImplementation(async (route: string) => {
    if (route === "GET /browser/tabs")
      return { tabs: [Object.assign({}, tab, { state: "unloaded", heldByUser: true })] }
    if (route === "POST /browser/tabs/:id/takeover/session")
      throw new ApiError(409, "unavailable", "BROWSER_TAKEOVER_UNAVAILABLE")
    return {}
  })

  fireEvent.click(screen.getByRole("button", { name: "Assumir" }))

  expect(await screen.findByText(/Esta sessão do navegador está indisponível/)).toBeVisible()
  expect(screen.getByText(/Nenhuma página foi reaberta/)).toBeVisible()
  expect(screen.queryByRole("region", { name: "Controle remoto do navegador" })).toBeNull()
  expect(screen.queryByText(/Você está no controle/)).toBeNull()
  expect(request).not.toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/frame",
    expect.anything(),
    expect.anything(),
  )

  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover", { hold: false }, { id: "browser-tab" }),
  )
  expect(screen.queryByText(/Esta sessão do navegador está indisponível/)).toBeNull()
})

test("only the take-over button starts the authorized browser control session", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]
  const { request } = renderCard(parts, false)
  const preview = await screen.findByRole("img", { name: "Página atual do navegador" })

  fireEvent.click(preview)

  expect(request).not.toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "browser-tab" })

  fireEvent.click(screen.getByRole("button", { name: "Assumir" }))

  expect(await screen.findByRole("region", { name: "Controle remoto do navegador" })).toBeVisible()
  expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/session", {}, { id: "browser-tab" })
})
