import type { ApiRoutes } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest, UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { ApiError } from "../../src/errors"
import "../../src/styles.css"

declare global {
  interface Window {
    historyFailing?: boolean
    serverStopped?: boolean
    serverRefused?: boolean
  }
}

initializeTheme()
const base = createMockApi()
const { group, thread: main } = await base.request("POST /groups", {
  name: "Publicações",
  color: "#2563eb",
  avatarShape: "classic-none",
  memberIds: ["bot-mark"],
  coordinatorBotId: "bot-mark",
})
const { thread: secondary } = await base.request(
  "POST /groups/:id/threads",
  { title: "Perfil de demonstração" },
  { id: group.id },
)
await base.request(
  "POST /threads/:id/messages",
  { text: "valide esse perfil e veja os posts", parentId: null, attachmentIds: [], sendId: crypto.randomUUID() },
  { id: secondary.id },
)
const query = new URLSearchParams(location.search)
// `?server=stoppable` starts healthy; the spec stops the server later, as quitting it does.
window.historyFailing = query.get("server") !== "stoppable"
window.serverStopped = false
// The exact refusal a restarting server sends while it drains active runs.
const request: ApiRequest = async (route, input, path, transport) => {
  // A stopped server never answers: the browser reports a connection failure before any HTTP status.
  if (window.serverStopped) throw new ApiError(0, "", undefined, "TOURI-E1009")
  // A proxy in front of a stopped server answers with an empty 503 instead.
  if (window.serverRefused) throw new ApiError(503, "")
  if (window.historyFailing && path?.id === secondary.id && route === "GET /threads/:id/messages")
    throw new ApiError(503, '{"errorCode":"RUNTIME_DRAINING"}', "RUNTIME_DRAINING")
  if (route === "GET /groups/:id/threads") {
    const response = await base.request("GET /groups/:id/threads", {}, { id: path?.id ?? "" })
    // Same-millisecond random IDs must not choose which conversation is the channel's main one.
    return {
      threads: response.threads.map((thread) => ({ ...thread, createdAt: thread.id === main.id ? 1 : 2 })),
    } as ApiRoutes[typeof route]["res"]
  }
  return base.request(route, input, path, transport)
}
const api: UiApi = { ...base, request }
localStorage.setItem("touri.sidebar.mode", "work")
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({
    botId: main.botId,
    // `?open=failing` starts on the conversation whose read is refused, as a reload during a restart does.
    threadId: query.get("open") === "failing" ? secondary.id : main.id,
    route: { section: "bots", screen: "chat" },
  }),
)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
