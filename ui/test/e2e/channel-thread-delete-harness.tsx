import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest, UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

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
  { title: "Publicação diária" },
  { id: group.id },
)
const state = base.getState()
// Synthetic persisted deletion emulates a server returning the updated index after reload.
state.threads.forEach((thread) => {
  if (thread.id === main.id) thread.createdAt = 1
})
if (localStorage.getItem("synthetic-channel-deleted"))
  await base.request("DELETE /threads/:id", {}, { id: secondary.id })
const request: ApiRequest = async (route, input, path) => {
  const response = await base.request(route, input, path)
  if (route === "DELETE /threads/:id" && path?.id === secondary.id)
    localStorage.setItem("synthetic-channel-deleted", "1")
  return response
}
const api: UiApi = { ...base, request }
localStorage.setItem("touri.sidebar.mode", "work")
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({
    botId: main.botId,
    threadId: localStorage.getItem("synthetic-channel-deleted") ? main.id : secondary.id,
    route: { section: "bots", screen: "chat" },
  }),
)
const root = document.getElementById("root")
if (root) root.dataset.mainThreadId = main.id
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
