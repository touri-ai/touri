import type { ApiRoutes, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import "../../src/styles.css"

const startStreamingFixture = () => {
  const mock = createMockApi()
  const template = mock.getState()
  const bot = template.bots[0]
  const thread = template.threads[0]
  const message = template.messages[0]
  const root = document.getElementById("root")
  if (!root || !bot || !thread || !message) throw new Error("Missing synthetic fixture")

  const bots = Array.from({ length: 8 }, (_, index) => ({
    ...bot,
    id: `stream-bot-${index}`,
    name: `Exemplo ${index + 1}`,
    title: "Revisão de exemplos",
    homeDir: "/workspace",
    mainThreadId: `stream-thread-${index}`,
    avatarSeed: `stream-${index}`,
    sortOrder: index,
  }))
  const threads = bots.map((bot) => ({ ...thread, id: bot.mainThreadId, botId: bot.id, activeLeafId: null }))
  const messages = Array.from({ length: 12 }, (_, index) => getMessage(message, index, true))
  const request: ApiRequest = async (route, input, paths = {}) => {
    if (route === "GET /bots") return { bots } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots/:id/threads")
      return { threads: threads.filter((thread) => thread.botId === paths.id) } as ApiRoutes[typeof route]["res"]
    if (route === "GET /workspace/activity") return { messages: [], runs: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/runs") return { runs: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/messages")
      return {
        messages: paths.id === "stream-thread-0" ? messages : [],
        activeLeafId: null,
      } as ApiRoutes[typeof route]["res"]

    return mock.request(route, input, paths)
  }
  localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "stream-bot-0", threadId: "stream-thread-0" }))
  document.documentElement.dataset.theme = "dark"
  installMotionTokens(document.documentElement)
  createRoot(root).render(<App kernel={{ services: { api: { ...mock, request } } }} />)

  window.addEventListener(
    "start-streaming-fixture",
    () => {
      bots.forEach((_, index) => {
        mock.emit({ type: "message.created", message: getMessage(message, index) })
      })
      // The fixture models eight independent event streams at 50 updates/second each.
      let offset = 0
      const timer = setInterval(() => {
        const delta = source.slice(offset, offset + 100)
        bots.forEach((_, index) => {
          mock.emit({
            type: "message.delta",
            threadId: `stream-thread-${index}`,
            messageId: `live-${index}`,
            partIndex: 0,
            offset,
            delta,
            updatedAt: Date.now(),
          })
        })
        offset += delta.length
        if (offset < source.length) return

        clearInterval(timer)
        bots.forEach((_, index) => {
          mock.emit({ type: "message.updated", message: getMessage(message, index, false, true) })
        })
        document.documentElement.dataset.streamingDone = "true"
      }, 20)
      window.addEventListener("pagehide", () => clearInterval(timer), { once: true })
    },
    { once: true },
  )
}

const source = Array.from(
  { length: 90 },
  (_, index) =>
    `## Etapa ${index + 1}\n\nTexto de exemplo com **destaque**, [fonte](https://example.test) e uma lista.\n\n- Conferir dados\n- Preparar resumo\n\n\`\`\`typescript\nconst etapa = ${index + 1}\nconsole.log("exemplo", etapa)\n\`\`\`\n\n`,
).join("")

const getMessage = (template: Message, index: number, history = false, complete = false): Message => {
  const liveText = complete ? source : ""
  const text = history ? `Exemplo salvo ${index + 1}.\n\n\`\`\`typescript\nconst exemplo = ${index}\n\`\`\`` : liveText

  return {
    ...template,
    id: `${history ? "history" : "live"}-${index}`,
    threadId: `stream-thread-${history ? 0 : index}`,
    parentId: null,
    role: "assistant",
    status: history || complete ? "complete" : "streaming",
    runId: null,
    text,
    parts: [{ type: "text", text }],
    createdAt: 1_790_000_000_000 + (history ? index : 100) * 1000,
    updatedAt: Date.now(),
  }
}

startStreamingFixture()
