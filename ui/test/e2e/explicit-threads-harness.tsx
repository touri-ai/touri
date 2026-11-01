import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
await api.request("PATCH /settings", { theme: theme as "light" | "dark" })
const { group, thread } = await api.request("POST /groups", { name: "Planejamento", memberIds: ["bot-mark"] })
const original = api.getState().messages.find((message) => message.role === "user")
const botReply = api
  .getState()
  .messages.find((message) => message.role === "assistant" && message.status === "complete")
if (!original || !botReply) throw new Error("Missing demo messages")
const request = {
  ...original,
  id: "thread-demo-request",
  threadId: thread.id,
  parentId: null,
  text: "Vamos planejar o lançamento da próxima semana.",
  parts: [{ type: "text" as const, text: "Vamos planejar o lançamento da próxima semana." }],
  sender: null,
  runId: null,
}
const reply = {
  ...botReply,
  id: "thread-demo-reply",
  threadId: thread.id,
  parentId: request.id,
  text: "Podemos organizar as entregas e revisar o cronograma juntos.",
  parts: [{ type: "text" as const, text: "Podemos organizar as entregas e revisar o cronograma juntos." }],
  sender: { id: "bot-mark", name: "mark" },
  runId: null,
}
// The transport holds synthetic records; the UI is the complete application and virtualized chat.
api.getState().messages.push(request, reply)
thread.activeLeafId = reply.id
await api.request("PATCH /threads/:id", { activeLeafId: reply.id }, { id: thread.id })
const root = document.getElementById("root")
if (!root) throw new Error("Missing root")
createRoot(root).render(<App kernel={{ services: { api } }} />)
void group
