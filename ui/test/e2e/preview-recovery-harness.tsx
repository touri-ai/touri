import type { ApiRoutes, BrowserTabInfo } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest, UiApi } from "../../src/api/client"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import { getChannelBrowserWorkspaceFixture } from "../channel-browser-workspace-fixture"

const fixture = await getChannelBrowserWorkspaceFixture()
// Only this synthetic transport owns these mutable controls; the app uses its normal events and requests.
const state = { started: false, outage: false, metadata: false, captures: 0 }
const tab: BrowserTabInfo & { ownerBotId: string } = {
  tabId: "channel-tab",
  ownerBotId: fixture.bot.id,
  url: "https://demo.example.test",
  title: "Página de demonstração",
  state: "live",
  openerTabId: null,
  heldByUser: false,
  lastUsedAt: 1,
}
const emitTab = (changes: Partial<BrowserTabInfo>) =>
  fixture.emit({ type: "browser.tab", tab: Object.assign({}, tab, changes) })
const getImage = () => {
  const canvas = document.createElement("canvas")
  canvas.width = 640
  canvas.height = 400
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Synthetic canvas unavailable")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, 640, 400)
  context.fillStyle = "#164e63"
  context.font = "bold 28px sans-serif"
  context.fillText("Página de demonstração", 32, 65)
  context.font = "20px sans-serif"
  context.fillText("Dados fictícios para testar a prévia", 32, 115)
  context.fillText(`Imagem ${state.captures}`, 32, 160)

  return canvas.toDataURL("image/png")
}
const request: ApiRequest = async (route, input, path, transport) => {
  if (route === "POST /threads/:id/messages") {
    const message = input as ApiRoutes[typeof route]["req"]
    if (!message.text.startsWith("@Léo ")) throw new Error("Synthetic browser task requires an explicit bot mention")

    state.started = true
    // Deliver the stream after the send response, as the real transport does.
    window.setTimeout(() => {
      fixture.emit({
        type: "thread.updated",
        thread: Object.assign({}, fixture.thread, { activeLeafId: fixture.reply.id }),
      })
      fixture.emit({ type: "message.updated", message: fixture.reply })
      fixture.emit({ type: "run.updated", run: fixture.run })
      fixture.emit({ type: "browser.channel_run", run: fixture.browserRun })
    }, 0)

    return {
      message: Object.assign({}, fixture.reply, {
        id: "browser-prompt",
        parentId: null,
        runId: null,
        role: "user",
        parts: [],
        text: "@Léo confira a página de demonstração.",
      }),
      thread: Object.assign({}, fixture.thread, { activeLeafId: fixture.reply.id }),
      run: fixture.run,
    } as ApiRoutes[typeof route]["res"]
  }
  if (!state.started && route === "GET /workspace/activity")
    return { messages: [], runs: [], browserRuns: [] } as ApiRoutes[typeof route]["res"]
  if (!state.started && (route === "GET /runs" || route === "GET /threads/:id/runs"))
    return { runs: [] } as ApiRoutes[typeof route]["res"]
  if (!state.started && route === "GET /threads/:id/messages" && path?.id === fixture.thread.id)
    return { messages: [], activeLeafId: null } as ApiRoutes[typeof route]["res"]
  if (route === "GET /bots/:id/browser-preview") {
    state.captures += 1
    if (state.outage) throw new Error("Synthetic temporary capture interruption")
    if (state.metadata) emitTab({ title: `Página de demonstração ${state.captures}`, lastUsedAt: state.captures })

    return { image: getImage(), title: tab.title, url: tab.url } as ApiRoutes[typeof route]["res"]
  }

  return fixture.api.request(route, input, path, transport)
}
const finish = () => {
  fixture.emit({
    type: "browser.channel_run",
    run: Object.assign({}, fixture.browserRun, { status: "succeeded", finishedAt: Date.now() }),
  })
  fixture.emit({
    type: "run.updated",
    run: Object.assign({}, fixture.run, { status: "succeeded", finishedAt: Date.now() }),
  })
  fixture.emit({
    type: "message.updated",
    message: Object.assign({}, fixture.reply, {
      status: "complete",
      text: "Página conferida com sucesso.",
      parts: [{ type: "text", text: "Página conferida com sucesso." }],
    }),
  })
}
const api: UiApi = Object.assign({}, fixture.api, { request, sendMessage: undefined })
Object.assign(window, {
  previewRecovery: {
    interrupt: () => {
      state.outage = true
      emitTab({ url: "https://demo.example.test/results" })
    },
    reconnect: () => {
      state.outage = false
      state.metadata = true
      emitTab({ state: "unloaded" })
    },
    finish,
    snapshot: () => Object.assign({}, state),
  },
})
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
