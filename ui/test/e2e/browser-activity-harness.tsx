import type { BrowserTabInfo, Message, ToolCallPart } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { TurnActivity } from "../../src/components/TurnActivity"
import { InlinePreviewContext } from "../../src/features/desktop/InlineLivePreview"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const locale = params.get("locale") === "en" ? "en" : "pt-BR"
document.documentElement.lang = locale
const attachmentImage = (() => {
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

  return canvas.toDataURL("image/png").split(",")[1] ?? ""
})()
const image = `data:image/png;base64,${attachmentImage}`
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
}
type BrowserActivityWindow = Window & { browserActivity?: { snapshot: () => BrowserActivitySnapshot } }

const getFixtureApi = ({
  currentPage,
  heldByUser,
  onHeldChange,
  onAttachmentRead,
}: {
  currentPage: { current: FixturePage }
  heldByUser: { current: boolean }
  onHeldChange: (held: boolean) => void
  onAttachmentRead: () => void
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
    if (route === "GET /bots/:id/browser-preview")
      return { image, title: currentPage.current.title, url: currentPage.current.url }
    if (route === "GET /attachments/:id/content") {
      onAttachmentRead()
      return {
        text: JSON.stringify({ content: [{ type: "image", mimeType: "image/png", data: attachmentImage }] }),
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
  const [confidence, setConfidence] = useState<number | null>(null)
  const [browserView, setBrowserView] = useState(false)
  const currentPage = useRef(initialPage)
  const heldByUser = useRef(false)
  const [fixture] = useState(() =>
    getFixtureApi({
      currentPage,
      heldByUser,
      onHeldChange: setHeld,
      onAttachmentRead: () => setAttachmentRead(true),
    }),
  )
  const { api, bot } = fixture
  const browserActivitySnapshot = useRef<BrowserActivitySnapshot>({ parts, running, started, results, attachmentRead })
  browserActivitySnapshot.current = { parts, running, started, results, attachmentRead }
  useEffect(() => {
    const browserWindow = window as BrowserActivityWindow
    browserWindow.browserActivity = { snapshot: () => browserActivitySnapshot.current }

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
    add("browser_screenshot", { tabId: tab.tabId }, "browser-final-screenshot")
  }

  return (
    <InlinePreviewContext.Provider value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer }}>
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
          {running && (
            <div className="composer-browser-status" role="status">
              {t("{name} is working · In the browser", { name: bot.name }, locale)}
            </div>
          )}
          <textarea aria-label={t("Message", {}, locale)} placeholder={t("Write a message…", {}, locale)} />
        </footer>
      </main>
    </InlinePreviewContext.Provider>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
