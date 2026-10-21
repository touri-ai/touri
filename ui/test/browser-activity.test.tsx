import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot, BrowserTabInfo, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BrowserActivityCard } from "../src/components/BrowserActivityCard"
import { BrowserActivityControlsProvider } from "../src/components/BrowserActivityControls"
import { BrowserWorkingStatus } from "../src/components/BrowserWorkingStatus"
import {
  getBrowserActivityNotice,
  getBrowserActivityTabId,
  getBrowserActivityUrl,
  getBrowserTakeoverReason,
} from "../src/components/browserActivityPresentation"
import { ChannelComposerChip } from "../src/features/channelBrowser/ChannelBrowser"
import { InlinePreviewContext } from "../src/features/desktop/InlineLivePreview"
import { startInlineFrameSource } from "../src/features/desktop/inlineFrameSource"
import { setInlinePreviewPreference } from "../src/features/desktop/inlinePreviewPreference"

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
  setInlinePreviewPreference(true)
  vi.clearAllMocks()
})

test("the browser working chip exposes a stop control", () => {
  const onStop = vi.fn()
  render(<BrowserWorkingStatus name="Lia" onStop={onStop} />)

  expect(screen.getByRole("status")).toHaveTextContent("Lia está trabalhando · No navegador")
  fireEvent.click(screen.getByRole("button", { name: "Parar" }))
  expect(onStop).toHaveBeenCalledOnce()
})

const tab = {
  tabId: "browser-tab",
  ownerBotId: "bot-mark",
  url: "https://travel.example.test/results",
  title: "Resultados de Lisboa",
  state: "live",
  openerTabId: null,
  heldByUser: false,
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
) => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "GET /browser/tabs") return getTabs()
    if (route === "POST /browser/tabs/:id/takeover/session")
      return { sessionId: "synthetic-session", controlEpoch: "synthetic-control-epoch", viewEpoch: 0 }
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
          url: "https://person:fixture-password@travel.example.test/results?token=fixture-token",
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
      <BrowserActivityCard parts={parts} finished={finished} createdAt={1} botName="Lia" />
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
  expect(screen.getByText("Clicou")).toBeVisible()
  expect(screen.getByText("Lia · Clicou")).toBeVisible()
  expect(screen.getByRole("progressbar", { name: "Progresso do navegador" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Expandir navegador" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Recolher cartão do navegador" })).toBeVisible()
  expect(document.querySelectorAll(".browser-activity-checklist li")).toHaveLength(3)
  await waitFor(() => expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible())
  expect(document.body.textContent).not.toContain("private search value")
  expect(document.body.textContent).not.toContain("person@example.test")
  expect(document.body.textContent).not.toContain("private-password")
  const displayedUrl = screen.getByText("https://travel.example.test")
  expect(displayedUrl).toHaveAttribute("title", "https://travel.example.test")
  expect(screen.getAllByText("https://travel.example.test")).toHaveLength(1)
  expect(document.body.textContent).not.toContain("invite-Q7z8k2fR")
  expect(document.body.textContent).not.toContain("fixture-token")
})

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

test("sanitizes a takeover reason before showing it", () => {
  const part = getPart({
    callId: "takeover",
    tool: "mcp__touri__browser_request_takeover",
    inputJson: JSON.stringify({ reason: "Confirm with fixture@example.test at 2025550142" }),
  })

  expect(getBrowserTakeoverReason([part])).toBe("Confirm with [email] at [number]")
})

test("shows one secure browser address and a live marker above the preview", async () => {
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  const address = await screen.findByRole("group", { name: "Endereço do navegador" })
  expect(address).toBeVisible()
  expect(screen.getByLabelText("Conexão segura")).toBeVisible()
  expect(within(address).getByText("Ao vivo")).toBeVisible()
  expect(screen.getAllByText("https://travel.example.test/results")).toHaveLength(1)
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

test("the finished browser summary shows its page title with the screenshot", async () => {
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

  renderCard(parts, true)

  expect(await screen.findByText("Resultados de Lisboa")).toBeVisible()
  expect(screen.getByRole("img", { name: "Captura final do navegador" })).toBeVisible()
})

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
      <BrowserActivityCard parts={parts} finished createdAt={1} botName="Lia" />
    </InlinePreviewContext.Provider>,
  )

  expect(await screen.findByText("Usou o navegador · 3 ações")).toBeVisible()
  expect(screen.getByText("Ver o que ele fez")).toBeVisible()
  expect(screen.getByRole("img", { name: "Captura final do navegador" })).toBeVisible()
  expect(screen.queryByText("Atividade do navegador")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Usou o navegador/ }))
  expect(await screen.findByText("Atividade do navegador")).toBeVisible()
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("GET /attachments/:id/content", expect.anything(), { id: "final-shot" }),
  )
  expect(document.body.textContent).not.toContain("fixture-password")
  expect(document.body.textContent).not.toContain("fixture-token")
})

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

  expect(await screen.findByText("Por que Lia parou")).toBeVisible()
  expect(screen.getByText("O site pediu login para continuar.")).toBeVisible()
  expect(screen.getByText("Últimas ações")).toBeVisible()
  expect(screen.getByText("Leu a página")).toBeVisible()
  expect(
    screen.getByText("O que você digitar no navegador não vai para o chat nem para o contexto do bot."),
  ).toBeVisible()
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

  expect(screen.queryByRole("img", { name: "Captura final do navegador" })).toBeNull()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull()
  expect(request).not.toHaveBeenCalledWith("GET /browser/tabs", expect.anything())
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

  expect(screen.getByText("A ação no navegador falhou. Assuma o controle para continuar.")).toBeVisible()
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

  expect(screen.getByRole("button", { name: "Continuar no navegador" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull()
})

test("disabling live chat previews prevents capture and leaves browser control available", () => {
  setInlinePreviewPreference(false)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  expect(startInlineFrameSource).not.toHaveBeenCalled()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Expandir navegador" })).toBeNull()
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

  expect(vi.mocked(startInlineFrameSource).mock.calls[0]?.[6]).toEqual({ intervalMs: 700 })

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
      <BrowserActivityCard parts={[oldPage, newPage]} finished={false} createdAt={1} botName="Lia" />
    </InlinePreviewContext.Provider>,
  )

  expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull()
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
