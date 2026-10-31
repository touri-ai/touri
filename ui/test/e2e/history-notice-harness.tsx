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
window.historyFailing = true
// The exact refusal a restarting server sends while it drains active runs.
const request: ApiRequest = async (route, input, path, transport) => {
  if (window.historyFailing && path?.id === secondary.id && route === "GET /threads/:id/messages")
    throw new ApiError(503, '{"errorCode":"RUNTIME_DRAINING"}', "RUNTIME_DRAINING")
  return base.request(route, input, path, transport)
}
const api: UiApi = { ...base, request }
localStorage.setItem("touri.sidebar.mode", "work")
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({
    botId: main.botId,
    // `?open=failing` starts on the conversation whose read is refused, as a reload during a restart does.
    threadId: new URLSearchParams(location.search).get("open") === "failing" ? secondary.id : main.id,
    route: { section: "bots", screen: "chat" },
  }),
)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
