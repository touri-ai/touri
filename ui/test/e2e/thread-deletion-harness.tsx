import type { Message, Thread } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const state = api.getState()
const baseThread = state.threads.find((thread) => thread.id === "thread-mark")
const baseMessage = state.messages[0]
if (!baseThread || !baseMessage) throw new Error("Missing mock conversation")
const timestamp = new Date("2026-08-01T10:00:00Z").getTime()
const thread: Thread = {
  ...baseThread,
  id: "thread-lead-events",
  title: "Eventos de leads",
  kind: "chat",
  activeLeafId: "message-lead-event",
  createdAt: timestamp,
  updatedAt: timestamp,
  unread: 0,
  archivedAt: new URLSearchParams(location.search).has("archived") ? timestamp : null,
}
const message: Message = {
  ...baseMessage,
  id: "message-lead-event",
  threadId: thread.id,
  parentId: null,
  role: "assistant",
  text: "Uma atualização automática de exemplo.",
  parts: [{ type: "text", text: "Uma atualização automática de exemplo." }],
  createdAt: timestamp,
  updatedAt: timestamp,
}
// The mock exposes mutable fixture collections for seeding before React mounts.
state.threads.push(thread)
state.messages.push(message)
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: "bot-mark", threadId: "thread-mark", route: { section: "bots", screen: "chat" } }),
)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
