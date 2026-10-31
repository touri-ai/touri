import type { Bot, BrowserTabInfo, Message, Run, Thread, ToolCallPart } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { AvatarRuntimeProvider } from "../../src/components/AvatarRuntime"
import { BrowserActivityControlsProvider } from "../../src/components/BrowserActivityControls"
import { BrowserWorkingStatus } from "../../src/components/BrowserWorkingStatus"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import { Composer } from "../../src/components/Composer"
import { TurnActivity } from "../../src/components/TurnActivity"
import { InlinePreviewContext } from "../../src/features/desktop/InlineLivePreview"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("browser-activity-fixture", params.get("flow") === "live")
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const locale = params.get("locale") === "en" ? "en" : "pt-BR"
document.documentElement.lang = locale
const fixtureImages = (() => {
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 500
  const context = canvas.getContext("2d")
  if (!context) return ""
  context.fillStyle = "#f8fafc"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#ffffff"
  context.fillRect(24, 24, 752, 56)
  context.fillRect(24, 108, 752, 340)
  context.strokeStyle = "#cbd5e1"
  context.strokeRect(24, 24, 752, 56)
  context.strokeRect(24, 108, 752, 340)
  context.fillStyle = "#0f172a"
  context.font = "22px sans-serif"
  context.fillText("touri · busca de viagem", 50, 60)
  context.font = "30px sans-serif"
  context.fillText("Lisboa, Portugal", 50, 165)
  context.fillStyle = "#475569"
  context.font = "18px sans-serif"
  context.fillText("24 de outubro · Econômica", 50, 215)
  context.fillStyle = "#2563eb"
  context.font = "20px sans-serif"
  context.fillText("Resultados de teste, dados fictícios", 50, 280)

  return {
    attachment: canvas.toDataURL("image/png").split(",")[1] ?? "",
    preview: canvas.toDataURL("image/jpeg", 0.8),
  }
})()
const attachmentImage = fixtureImages.attachment
const image = fixtureImages.preview
const attachmentBytes = Math.floor((attachmentImage.length * 3) / 4)
const initialPage = { title: t("Travel search fixture", {}, locale), url: "https://travel.example.test/search" }
const resultPage = { title: t("Search results", {}, locale), url: "https://travel.example.test/results" }
const tab = {
  tabId: "browser-search-tab",
  ownerBotId: "bot-mark",
  url: initialPage.url,
  title: initialPage.title,
  state: "live",
  openerTabId: null,
  heldByUser: false,
  lastUsedAt: Date.now(),
} satisfies BrowserTabInfo & { ownerBotId: string }

type FixturePage = { title: string; url: string }
type BrowserActivitySnapshot = {
  parts: ToolCallPart[]
  running: boolean
  started: boolean
  results: boolean
  attachmentRead: boolean
  previewRequests: number
  maxUiLongTaskMs: number
  longTaskObserverAvailable: boolean
  takeoverInputCount: number
}
type BrowserActivityWindow = Window & {
  browserActivity?: { resetPreviewMetrics: () => void; snapshot: () => BrowserActivitySnapshot }
}

const previewMetrics = { requests: 0, maxLongTaskMs: 0, observerAvailable: false }
const previewLongTaskObserver =
  typeof PerformanceObserver === "undefined"
    ? undefined
    : new PerformanceObserver((list) => {
        previewMetrics.maxLongTaskMs = list
          .getEntries()
          .reduce((maximum, entry) => Math.max(maximum, entry.duration), previewMetrics.maxLongTaskMs)
      })
try {
  previewLongTaskObserver?.observe({ entryTypes: ["longtask"] })
  previewMetrics.observerAvailable = previewLongTaskObserver !== undefined
} catch {
  previewMetrics.observerAvailable = false
}

const getFixtureApi = ({
  currentPage,
  heldByUser,
  onHeldChange,
  onAttachmentRead,
  onPreviewRequested,
  onTakeoverInput,
}: {
  currentPage: { current: FixturePage }
  heldByUser: { current: boolean }
  onHeldChange: (held: boolean) => void
  onAttachmentRead: () => void
  onPreviewRequested: () => void
  onTakeoverInput: () => void
}) => {
  const api = createMockApi()
  const bot = api.getState().bots.find((item) => item.id === "bot-mark")
  if (!bot) throw new Error("Fixture bot is missing")

  api.request = (async (route: string, input?: unknown) => {
    if (route === "GET /browser/tabs")
      return {
        tabs: [
          { ...tab, heldByUser: heldByUser.current, url: currentPage.current.url, title: currentPage.current.title },
        ],
      }
    if (route === "POST /browser/tabs/:id/takeover") {
      const held = (input as { hold: boolean }).hold
      heldByUser.current = held
      onHeldChange(held)
      return {}
    }
    if (route === "GET /bots/:id/browser-preview") {
      onPreviewRequested()
      if (params.get("previewStall") === "true") return new Promise<never>(() => {})
      return { image, title: currentPage.current.title, url: currentPage.current.url }
    }
    if (route === "POST /browser/tabs/:id/takeover/session") {
      heldByUser.current = true
      onHeldChange(true)
      return { sessionId: "synthetic-browser-session", controlEpoch: "synthetic-control-epoch", viewEpoch: 0 }
    }
    if (route === "POST /browser/tabs/:id/takeover/frame") {
      const viewEpoch = (input as { viewEpoch: number }).viewEpoch
      return {
        controlEpoch: "synthetic-control-epoch",
        targetEpoch: 1,
        viewEpoch,
        title: currentPage.current.title,
        url: currentPage.current.url,
        image,
        width: 800,
        height: 500,
      }
    }
    if (route === "POST /browser/tabs/:id/takeover/input") {
      onTakeoverInput()
      return {}
    }
    if (route === "DELETE /browser/tabs/:id/takeover/session") {
      heldByUser.current = false
      onHeldChange(false)
      return {}
    }
    if (route === "GET /attachments/:id/content") {
      onAttachmentRead()
      return {
        text: JSON.stringify({
          title: currentPage.current.title,
          url: currentPage.current.url,
          content: [{ type: "image", mimeType: "image/png", data: attachmentImage }],
        }),
        offset: 0,
        nextOffset: null,
        bytes: attachmentBytes,
      }
    }

    return {}
  }) as ApiRequest

  return { api, bot }
}

const makePart = (
  callId: string,
  tool: string,
  input: Record<string, unknown>,
  outputAttachmentId?: string,
): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool: `mcp__touri__${tool}`,
  summary: tool,
  inputJson: JSON.stringify(input),
  outputJson: outputAttachmentId ? null : JSON.stringify({ structured: { tabId: "browser-search-tab" } }),
  ...(outputAttachmentId ? { outputAttachmentId, outputBytes: attachmentBytes, outputPreview: "" } : {}),
  startedAt: Date.now(),
  resolvedAt: Date.now(),
  ok: true,
})

const Fixture = () => {
  const [parts, setParts] = useState<ToolCallPart[]>([])
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(false)
  const [destination, setDestination] = useState("")
  const [suggestions, setSuggestions] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const [date, setDate] = useState("")
  const [results, setResults] = useState(false)
  const [held, setHeld] = useState(false)
  const [attachmentRead, setAttachmentRead] = useState(false)
  const [takeoverInputCount, setTakeoverInputCount] = useState(0)
  const [confidence, setConfidence] = useState<number | null>(null)
  const [browserView, setBrowserView] = useState(false)
  const currentPage = useRef(initialPage)
  const heldByUser = useRef(false)
  const remote = params.get("remote") === "true"
  const [fixture] = useState(() =>
    getFixtureApi({
      currentPage,
      heldByUser,
      onHeldChange: setHeld,
      onAttachmentRead: () => setAttachmentRead(true),
      onPreviewRequested: () => {
        previewMetrics.requests += 1
      },
      onTakeoverInput: () => setTakeoverInputCount((count) => count + 1),
    }),
  )
  const { api, bot } = fixture
  const activityBot = remote ? { ...bot, machine: "vm" as const } : bot
  const browserActivitySnapshot = useRef<BrowserActivitySnapshot>({
    parts,
    running,
    started,
    results,
    attachmentRead,
    previewRequests: previewMetrics.requests,
    maxUiLongTaskMs: previewMetrics.maxLongTaskMs,
    longTaskObserverAvailable: previewMetrics.observerAvailable,
    takeoverInputCount,
  })
  browserActivitySnapshot.current = {
    parts,
    running,
    started,
    results,
    attachmentRead,
    previewRequests: previewMetrics.requests,
    maxUiLongTaskMs: previewMetrics.maxLongTaskMs,
    longTaskObserverAvailable: previewMetrics.observerAvailable,
    takeoverInputCount,
  }
  useEffect(() => {
    const browserWindow = window as BrowserActivityWindow
    browserWindow.browserActivity = {
      snapshot: () => ({
        ...browserActivitySnapshot.current,
        previewRequests: previewMetrics.requests,
        maxUiLongTaskMs: previewMetrics.maxLongTaskMs,
        longTaskObserverAvailable: previewMetrics.observerAvailable,
      }),
      resetPreviewMetrics: () => {
        previewLongTaskObserver?.takeRecords()
        previewMetrics.requests = 0
        previewMetrics.maxLongTaskMs = 0
      },
    }

    return () => {
      delete browserWindow.browserActivity
    }
  }, [])
  const onOpenComputer = () => setBrowserView(true)
  const add = (tool: string, input: Record<string, unknown>, outputAttachmentId?: string) => {
    setParts((previous) => [...previous, makePart(`action-${previous.length + 1}`, tool, input, outputAttachmentId)])
  }
  const start = () => {
    heldByUser.current = false
    setHeld(false)
    setStarted(true)
    setRunning(true)
    currentPage.current = initialPage
    add("browser_open", { url: initialPage.url })
  }
  const updateDestination = (value: string) => {
    setDestination(value)
    setSuggestions(Boolean(value))
    if (value)
      add("browser_type", { tabId: tab.tabId, target: { kind: "role", role: "textbox", name: "Destino" }, text: value })
  }
  const chooseSuggestion = () => {
    const options = ["Lisboa, Portugal", "Lisboa Airport"]
    const answer = { choice: "Lisboa, Portugal", confidence: 0.96, options }
    const fallback = params.get("fallback")
    if (fallback === "no_credit" || fallback === "missing_key") {
      setParts((previous) => [
        ...previous,
        {
          ...makePart(`action-${previous.length + 1}`, "browser_click", { tabId: tab.tabId }),
          ok: false,
          outputJson: JSON.stringify({ content: [{ type: "text", text: `TOURI_BROWSER_DECISION_HINT|${fallback}` }] }),
        },
      ])
    }
    setConfidence(fallback === "no_credit" || fallback === "missing_key" ? null : answer.confidence)
    setDestination(answer.choice)
    setSuggestions(false)
    add("browser_click", { tabId: tab.tabId, target: { kind: "role", role: "option", name: answer.choice } })
  }
  const selectCabin = () =>
    add("browser_select_option", {
      tabId: tab.tabId,
      target: { kind: "role", role: "combobox", name: "Cabine" },
      values: ["economy"],
    })
  const openCalendar = () => {
    setDateOpen(true)
    add("browser_click", {
      tabId: tab.tabId,
      target: { kind: "role", role: "button", name: "Abrir calendário de partida" },
    })
  }
  const chooseDate = () => {
    setDate(t("October 24", {}, locale))
    setDateOpen(false)
    add("browser_click", {
      tabId: tab.tabId,
      target: { kind: "role", role: "button", name: "Data de partida 24 de outubro" },
    })
  }
  const finish = () => {
    if (heldByUser.current) return
    setResults(true)
    setRunning(false)
    currentPage.current = resultPage
    add("browser_snapshot", { tabId: tab.tabId })
    if (params.get("screenshot") !== "none") add("browser_screenshot", { tabId: tab.tabId }, "browser-final-screenshot")
  }

  return (
    <InlinePreviewContext.Provider
      value={{ api, bot: activityBot, machine: undefined, activeCallId: undefined, onOpenComputer }}
    >
      <BrowserActivityControlsProvider>
        <main className="browser-activity-demo">
          <header>
            <div>
              <p className="eyebrow">touri · {t("Local browser fixture", {}, locale)}</p>
              <h1>{t("Travel search fixture", {}, locale)}</h1>
            </div>
            {!started && (
              <button type="button" className="button" onClick={start}>
                {t("Start travel search", {}, locale)}
              </button>
            )}
          </header>
          <section className="browser-fixture-card" aria-label={t("Travel search fixture", {}, locale)}>
            <label htmlFor="destination">{t("Destination", {}, locale)}</label>
            <input
              id="destination"
              aria-label={t("Destination", {}, locale)}
              value={destination}
              onChange={(event) => updateDestination(event.target.value)}
            />
            {suggestions && (
              <div role="listbox" aria-label={t("Destination suggestions", {}, locale)}>
                {[t("Lisboa, Portugal", {}, locale), t("Lisboa Airport", {}, locale)].map((choice) => (
                  <button type="button" key={choice} role="option" onClick={chooseSuggestion}>
                    {choice}
                  </button>
                ))}
              </div>
            )}
            <label htmlFor="cabin">{t("Cabin", {}, locale)}</label>
            <select id="cabin" aria-label={t("Cabin", {}, locale)} onChange={selectCabin}>
              <option value="economy">{t("Economy", {}, locale)}</option>
              <option value="business">{t("Business", {}, locale)}</option>
            </select>
            <button type="button" className="button button-quiet" onClick={openCalendar}>
              {t("Open departure calendar", {}, locale)}
            </button>
            {dateOpen && (
              <button type="button" aria-label={t("Departure date October 24", {}, locale)} onClick={chooseDate}>
                {t("October 24", {}, locale)}
              </button>
            )}
            {date && <p>{t("Selected date: {date}", { date }, locale)}</p>}
            {running && confidence !== null && (
              <p role="status">{t("JEV confidence: {percent}%", { percent: Math.round(confidence * 100) }, locale)}</p>
            )}
            {running && (
              <button type="button" className="button" disabled={held} onClick={finish}>
                {t("Search trips", {}, locale)}
              </button>
            )}
            {results && (
              <section aria-label={t("Search results", {}, locale)}>
                <h2>{t("Search results", {}, locale)}</h2>
                <ul>
                  <li>{t("Lisboa · direct · fictional trip", {}, locale)}</li>
                  <li>{t("Lisboa Airport · connection", {}, locale)}</li>
                </ul>
                <p>{t("The local search is complete.", {}, locale)}</p>
              </section>
            )}
          </section>
          {browserView && (
            <p className="browser-live-view" role="status">
              {t("Live browser view opened", {}, locale)}
            </p>
          )}
          {started && (
            <TurnActivity
              message={
                {
                  id: "browser-reply",
                  threadId: "browser-thread",
                  parentId: null,
                  role: "assistant",
                  kind: "text",
                  status: running ? "streaming" : "complete",
                  runId: null,
                  text: "",
                  parts,
                  sender: { name: bot.name, id: bot.id },
                  source: "local",
                  createdAt: Date.now() - 1_000,
                  updatedAt: Date.now(),
                } satisfies Message
              }
              api={api}
              state={running ? "working-tool" : "done"}
              locale={locale}
            />
          )}
          <footer className="browser-activity-composer">
            {running && <BrowserWorkingStatus name={bot.name} botId={bot.id} locale={locale} />}
            <textarea aria-label={t("Message", {}, locale)} placeholder={t("Write a message…", {}, locale)} />
          </footer>
        </main>
      </BrowserActivityControlsProvider>
    </InlinePreviewContext.Provider>
  )
}

const requestBrowserFixture = async (step: string, payload?: Record<string, unknown>) => {
  const response = await fetch("/__browser-activity-fixture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, ...payload }),
  })
  if (!response.ok) throw new Error(`The browser fixture could not run ${step}.`)

  return response.json() as Promise<{
    part?: ToolCallPart
    snapshot?: { title: string; url: string }
    image?: string
  }>
}

const getBrowserRun = (bot: Bot, thread: Thread, requestMessageId: string, now: number): Run => ({
  id: "browser-flow-run",
  threadId: thread.id,
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  requestMessageId,
  replyMessageId: null,
  externalTurnId: null,
  status: "running",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: now - 1_000,
  startedAt: now - 1_000,
  finishedAt: null,
})

type LiveBrowserActivitySnapshot = {
  running: boolean
  settled: boolean
  cancelledRunIds: string[]
  parts: ToolCallPart[]
}

type LiveBrowserActivityWindow = Window & {
  browserActivity?: {
    snapshot: () => LiveBrowserActivitySnapshot
    continueAfterOpen: () => void
  }
}

const LiveFixture = () => {
  const [fixture] = useState(() => {
    const fixtureApi = createMockApi()
    const originalRequest = fixtureApi.request
    const mockBot = fixtureApi.getState().bots[0]
    const mockThread = fixtureApi.getState().threads[0]
    if (!mockBot || !mockThread) throw new Error("The mocked bot is missing.")
    const fixtureBot = { ...mockBot, id: "browser-demo", name: "Lia", machine: "local" as const }
    const fixtureThread = { ...mockThread, id: "browser-thread", botId: fixtureBot.id }
    const request = (async (route: string, input?: unknown, pathValues?: Record<string, string>) => {
      const tabId = pathValues?.id ?? ""
      if (route === "GET /browser/tabs") {
        const result = await requestBrowserFixture("metadata")
        return result as never
      }
      if (route === "GET /bots/:id/browser-preview") {
        const result = await requestBrowserFixture("preview")
        return result as never
      }
      if (route === "GET /attachments/:id/content") {
        const result = await requestBrowserFixture("attachment")
        const imageData = result.image?.split(",")[1] ?? ""
        return {
          text: JSON.stringify({ content: [{ type: "image", mimeType: "image/jpeg", data: imageData }] }),
          offset: 0,
          nextOffset: null,
          bytes: Math.floor((imageData.length * 3) / 4),
        } as never
      }
      if (route === "POST /browser/tabs/:id/takeover/session")
        return (await requestBrowserFixture("takeover-session", { tabId })) as never
      if (route === "POST /browser/tabs/:id/takeover/frame")
        return (await requestBrowserFixture("takeover-frame", {
          tabId,
          ...(input as Record<string, unknown>),
        })) as never
      if (route === "POST /browser/tabs/:id/takeover/input") {
        return (await requestBrowserFixture("takeover-input", {
          tabId,
          ...(input as Record<string, unknown>),
        })) as never
      }
      if (route === "DELETE /browser/tabs/:id/takeover/session") {
        await requestBrowserFixture("takeover-release", { tabId, ...(input as Record<string, unknown>) })
        return {} as never
      }
      return originalRequest(route as Parameters<ApiRequest>[0], input as never, pathValues)
    }) as ApiRequest
    fixtureApi.request = request

    return [fixtureApi, fixtureBot, fixtureThread] as const
  })
  const [api, bot, thread] = fixture
  const [parts, setParts] = useState<ToolCallPart[]>([])
  const [narrations, setNarrations] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [started, setStarted] = useState(false)
  const [scriptSettled, setScriptSettled] = useState(true)
  const [cancelledRunIds, setCancelledRunIds] = useState<string[]>([])
  const stopped = useRef(false)
  const continueAfterOpen = useRef<(() => void) | null>(null)
  const ids = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState("")
  const now = Date.now()
  const userMessage: Message = {
    id: "browser-user-request",
    threadId: thread.id,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: "Encontre opções fictícias de viagem para Lisboa em 24 de outubro.",
    parts: [{ type: "text", text: "Encontre opções fictícias de viagem para Lisboa em 24 de outubro." }],
    sender: null,
    source: "local",
    createdAt: now - 2_000,
    updatedAt: now - 2_000,
  }
  const narrationParts = narrations.map((text) => ({ type: "text", text }) as const)
  const assistantMessage: Message = {
    id: "browser-assistant-reply",
    threadId: thread.id,
    parentId: userMessage.id,
    role: "assistant",
    kind: "text",
    status: running ? "streaming" : "complete",
    runId: null,
    text: "",
    parts: [...narrationParts, ...parts],
    sender: { id: bot.id, name: bot.name },
    source: "local",
    createdAt: now - 1_000,
    updatedAt: now,
  }
  const activeRun = running ? getBrowserRun(bot, thread, userMessage.id, now) : null
  const liveSnapshot = useRef<LiveBrowserActivitySnapshot>({ running, settled: scriptSettled, cancelledRunIds, parts })
  liveSnapshot.current = { running, settled: scriptSettled, cancelledRunIds, parts }

  useEffect(() => {
    const browserWindow = window as LiveBrowserActivityWindow
    browserWindow.browserActivity = {
      snapshot: () => liveSnapshot.current,
      continueAfterOpen: () => {
        continueAfterOpen.current?.()
        continueAfterOpen.current = null
      },
    }

    return () => {
      delete browserWindow.browserActivity
    }
  }, [])

  const playStep = async (step: string, narration: string, inputJson: string): Promise<void> => {
    if (stopped.current) return
    setNarrations((previous) => [...previous, narration])
    const callId = `browser-flow-${ids.current + 1}`
    ids.current += 1
    const toolNames: Record<string, string> = {
      read: "browser_snapshot",
      destination: "browser_type",
      option: "browser_click",
      cabin: "browser_select_option",
      calendar: "browser_click",
      date: "browser_click",
      search: "browser_click",
      wait: "browser_wait_for",
      tabs: "browser_list_tabs",
      screenshot: "browser_screenshot",
    }
    const toolName = toolNames[step] ?? `browser_${step}`
    const pending: ToolCallPart = {
      type: "tool_call",
      callId,
      tool: `mcp__touri__${toolName}`,
      summary: `browser_${step}`,
      inputJson,
      outputJson: null,
      startedAt: Date.now(),
      ok: null,
    }
    setParts((previous) => [...previous, pending])
    if (stopped.current) return
    const result = await requestBrowserFixture(step)
    const completedPart = result.part
    if (!completedPart) throw new Error(`The browser fixture returned no action for ${step}.`)
    setParts((previous) => previous.map((part) => (part.callId === callId ? { ...completedPart, callId } : part)))
    if (step !== "open") return
    if (params.get("holdAfterOpen") !== "true") return
    await new Promise<void>((resolve) => {
      continueAfterOpen.current = resolve
    })
  }

  const start = async () => {
    stopped.current = false
    continueAfterOpen.current = null
    ids.current = 0
    setStarted(true)
    setRunning(true)
    setScriptSettled(false)
    setCancelledRunIds([])
    setNarrations([])
    setParts([])
    const script = [
      ["open", "Vou abrir a busca de viagens.", JSON.stringify({ url: "https://travel.example.test/search" })],
      ["read", "A página inicial carregou. Vou procurar Lisboa.", "{}"],
      ["destination", "Estou preenchendo o destino.", '{"target":{"name":"Destination"}}'],
      ["option", "Encontrei Lisboa. Vou escolher essa opção.", '{"target":{"name":"Lisboa, Portugal"}}'],
      ["cabin", "Agora vou escolher a cabine.", '{"target":{"name":"Cabin"}}'],
      ["calendar", "Vou abrir as datas disponíveis.", '{"target":{"name":"Departure date"}}'],
      ["date", "Vou selecionar 24 de outubro.", '{"target":{"name":"October 24"}}'],
      ["search", "Tudo pronto. Vou buscar as opções.", '{"target":{"name":"Search trips"}}'],
      ["wait", "A busca terminou. Vou conferir os resultados.", '{"text":"Two ways to get there"}'],
      ["read", "Encontrei duas opções fictícias.", "{}"],
      ["tabs", "Vou conferir a aba atual antes de concluir.", "{}"],
      ["screenshot", "Vou guardar uma captura dos resultados.", "{}"],
    ] as const
    for (const [step, narration, inputJson] of script) {
      await playStep(step, narration, inputJson)
      if (stopped.current) {
        setScriptSettled(true)
        return
      }
    }
    setParts((previous) => [
      ...previous,
      {
        type: "text",
        text: "Encontrei duas opções fictícias para **Lisboa, Portugal** em **24 de outubro**:\n\n1. **Voo direto** — 2 h 30 min · cabine executiva · €184.\n2. **Uma conexão** — 4 h 10 min · €139.",
      },
    ])
    setRunning(false)
    setScriptSettled(true)
  }

  const stop = () => {
    stopped.current = true
    setRunning(false)
  }
  const cancel = async (runId: string) => {
    setCancelledRunIds((previous) => [...previous, runId])
    stop()
  }

  return (
    <AvatarRuntimeProvider
      value={{
        bots: [bot],
        threads: [thread],
        messages: [userMessage, assistantMessage],
        runs: [],
        notifications: [],
        loading: false,
      }}
    >
      <InlinePreviewContext.Provider
        value={{
          api,
          bot,
          machine: undefined,
          activeCallId: undefined,
          onOpenComputer: () => undefined,
        }}
      >
        <BrowserActivityControlsProvider>
          <main className="browser-flow-app" data-theme={params.get("theme") ?? "dark"}>
            <aside className="browser-flow-sidebar" aria-label="Conversas">
              <strong>touri</strong>
              <button type="button" className="browser-flow-sidebar-row" onClick={() => undefined}>
                <span>Busca de viagem</span>
                {running && <small>trabalhando</small>}
              </button>
            </aside>
            <section className="browser-flow-chat">
              <header className="browser-flow-header">
                <span>Busca de viagem</span>
                {!started && (
                  <button type="button" className="button" onClick={() => void start()}>
                    Iniciar busca de viagem
                  </button>
                )}
              </header>
              <div className="browser-flow-messages">
                <VirtualMessageList
                  api={api}
                  messages={started ? [userMessage, assistantMessage] : [userMessage]}
                  mainThread
                  onSwitchBranch={() => undefined}
                  onRetry={async () => undefined}
                />
              </div>
              <footer className="browser-flow-composer">
                <Composer
                  bot={bot}
                  threadId={thread.id}
                  parentId={userMessage.id}
                  api={api}
                  draft={draft}
                  onDraft={setDraft}
                  inputRef={inputRef}
                  activeRun={activeRun}
                  browserWorking={running}
                  browserBotName={bot.name}
                  queuedCount={0}
                  onSend={async () => {}}
                  onCancel={cancel}
                />
              </footer>
            </section>
          </main>
        </BrowserActivityControlsProvider>
      </InlinePreviewContext.Provider>
    </AvatarRuntimeProvider>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(params.get("flow") === "live" ? <LiveFixture /> : <Fixture />)
