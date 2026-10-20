import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { BrowserTabInfo, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BrowserActivityCard } from "../src/components/BrowserActivityCard"
import {
  getBrowserActivityNotice,
  getBrowserActivityTabId,
  getBrowserActivityUrl,
} from "../src/components/browserActivityPresentation"
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
        url: "https://person@example.test:private-password@travel.example.test/results?email=person@example.test",
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

const renderCard = (parts: ToolCallPart[], finished: boolean, getTabs = async () => ({ tabs: [tab] })) => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "GET /browser/tabs") return getTabs()
    if (route === "GET /attachments/:id/content")
      return {
        text: JSON.stringify({
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
  const bot = api.getState().bots[0] ?? null
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
  expect(screen.getByText("Preencheu Destination")).toBeVisible()
  expect(screen.getByText("Clicou em Lisboa, Portugal")).toBeVisible()
  await waitFor(() => expect(screen.getByRole("img", { name: "Página atual do navegador" })).toBeVisible())
  expect(document.body.textContent).not.toContain("private search value")
  expect(document.body.textContent).not.toContain("person@example.test")
  expect(document.body.textContent).not.toContain("private-password")
  expect(screen.getAllByText("https://travel.example.test/results")).toHaveLength(2)
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
  const takeOver = await screen.findByRole("button", { name: "Assumir controle" })

  fireEvent.click(takeOver)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover", { hold: true }, { id: "browser-tab" }),
  )
  expect(onOpenComputer).toHaveBeenCalledOnce()

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

test("historical browser cards never sample or take over the current browser page", async () => {
  const parts = [getPart({ callId: "old", tool: "browser_open", inputJson: "{}" })]
  const { request } = renderCard(parts, true)

  fireEvent.click(screen.getByRole("button", { name: /Usou o navegador/ }))

  expect(screen.queryByRole("img", { name: "Captura final do navegador" })).toBeNull()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Assumir controle" })).toBeNull()
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

  expect(screen.getByRole("button", { name: "Devolver para Lia" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Assumir controle" })).toBeNull()
})

test("disabling live chat previews prevents capture and leaves browser control available", () => {
  setInlinePreviewPreference(false)
  const parts = [getPart({ callId: "open", tool: "browser_open", inputJson: '{"tabId":"browser-tab"}' })]

  renderCard(parts, false)

  expect(startInlineFrameSource).not.toHaveBeenCalled()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Expandir navegador" })).toBeNull()
  expect(screen.getByText("Atividade do navegador")).toBeVisible()
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeVisible()
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
  await screen.findByRole("button", { name: "Assumir controle" })
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

  expect(screen.queryByRole("button", { name: "Assumir controle" })).toBeNull()
  expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()

  await act(async () => {
    resolveTabs({ tabs: [{ ...tab, tabId: "new-tab" }] })
    await nextTabs
  })
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /browser/tabs/:id/takeover", { hold: true }, { id: "new-tab" }),
  )
})
