import type { ApiRoutes, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const base = createMockApi()
const bot = base.getState().bots[0]
if (!bot) throw new Error("Missing synthetic bot")
const { thread } = await base.request("POST /groups", {
  name: "Engenharia",
  color: "#c2410c",
  memberIds: [bot.id],
  coordinatorBotId: null,
})
const timestamp = Date.now()
const getMessages = (threadId: string): Message[] => [
  {
    id: `owner-${threadId}`,
    threadId,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: `@${bot.name} vamos revisar a entrega de hoje.`,
    parts: [{ type: "text", text: `@${bot.name} vamos revisar a entrega de hoje.` }],
    sender: { id: "owner", name: "Pessoa Teste", kind: "person" },
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: `bot-${threadId}`,
    threadId,
    parentId: `owner-${threadId}`,
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: null,
    text: "A revisão está pronta para você conferir.",
    parts: [{ type: "text", text: "A revisão está pronta para você conferir." }],
    sender: { id: bot.id, name: bot.name },
    source: "local",
    createdAt: timestamp + 1000,
    updatedAt: timestamp + 1000,
  },
  {
    id: `integration-${threadId}`,
    threadId,
    parentId: `bot-${threadId}`,
    role: "user",
    kind: "notice",
    status: "complete",
    runId: null,
    text: "A entrega de demonstração foi registrada.",
    parts: [{ type: "text", text: "A entrega de demonstração foi registrada." }],
    sender: { id: "integration:delivery", name: "touri avisos", kind: "integration", avatarSeed: "delivery" },
    source: "local",
    createdAt: timestamp + 2000,
    updatedAt: timestamp + 2000,
  },
]
const request: ApiRequest = async (route, input, path, transport) => {
  if (route === "GET /session")
    return {
      ok: true,
      kind: "device",
      person: { id: "owner", name: "Pessoa Teste", email: null, avatarSeed: "owner", role: "admin" },
    } as ApiRoutes[typeof route]["res"]
  if (route === "GET /groups/:id/people")
    return {
      people: [{ id: "owner", name: "Pessoa Teste", avatarSeed: "owner", role: "admin" }],
    } as ApiRoutes[typeof route]["res"]
  if (route === "GET /threads/:id/messages")
    return {
      messages: getMessages(path?.id ?? thread.id),
      activeLeafId: `integration-${path?.id ?? thread.id}`,
    } as ApiRoutes[typeof route]["res"]
  return base.request(route, input, path, transport)
}
initializeTheme()
localStorage.setItem("touri.sidebar.mode", "bots")
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: { ...base, isMock: false, request } } }} />)
