import type { ApiRoutes, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const base = createMockApi()
const { bot } = await base.request("PATCH /bots/:id", { name: "Atlas" }, { id: "bot-mark" })
const { thread } = await base.request("POST /groups", {
  name: "Atlas",
  color: "#2563eb",
  avatarShape: "classic-none",
  memberIds: [bot.id],
  coordinatorBotId: null,
})
const isBefore = new URLSearchParams(location.search).get("phase") === "before"
const message: Message = {
  id: "notice",
  threadId: thread.id,
  parentId: null,
  role: isBefore ? "user" : "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Publicação concluída. @pessoa, a revisão está pronta.",
  parts: [{ type: "text", text: "Publicação concluída. @pessoa, a revisão está pronta." }],
  sender: isBefore ? { id: "owner", name: "Pessoa A", kind: "person" } : { id: bot.id, name: bot.name },
  source: "local",
  createdAt: Date.UTC(2026, 9, 30, 12),
  updatedAt: Date.UTC(2026, 9, 30, 12),
}
const request: ApiRequest = async <K extends keyof ApiRoutes>(
  route: K,
  input: ApiRoutes[K]["req"],
  values: Record<string, string> = {},
): Promise<ApiRoutes[K]["res"]> => {
  if (route === "GET /threads/:id/messages" && values.id === thread.id)
    return { messages: [message], activeLeafId: message.id } as ApiRoutes[K]["res"]
  if (route === "GET /workspace/activity") {
    const activity = await base.request("GET /workspace/activity", {})

    return { ...activity, messages: [...activity.messages, message] } as ApiRoutes[K]["res"]
  }

  return base.request(route, input, values)
}
const api = { ...base, request }
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: bot.id, threadId: thread.id, route: { section: "bots", screen: "chat" } }),
)
localStorage.setItem("touri.appearance.v1", "dark")
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
