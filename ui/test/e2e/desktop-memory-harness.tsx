import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import "../../src/styles.css"

const mock = createMockApi()
const seed = mock.getState()
const bot = seed.bots[0]
const thread = seed.threads[0]
const message = seed.messages[0]
if (!bot || !thread || !message) throw new Error("Missing memory fixture")

const bots = Array.from({ length: 30 }, (_, index) => ({
  ...bot,
  id: `sample-bot-${index}`,
  name: `Bot de exemplo ${index + 1}`,
  homeDir: `/workspace/bot-${index}`,
  mainThreadId: `sample-thread-${index}`,
  projectId: null,
  avatarPath: null,
}))
const languages = ["typescript", "javascript", "json", "python", "bash", "css", "html", "sql", "yaml", "rust"]
const source = 'const sample = { value: 42, label: "exemplo" };\n// Revisar o resultado\nconsole.log(sample);'
const messages: Message[] = Array.from({ length: 60 }, (_, index) => {
  const assistant = index % 2 === 1
  const text = assistant
    ? `## Exemplo ${index}\n\n\`\`\`${languages[Math.floor(index / 2) % languages.length]}\n${source}\n\`\`\``
    : `Revise o exemplo ${index + 1}.`
  return {
    ...message,
    id: `sample-message-${index}`,
    threadId: "sample-thread-0",
    parentId: index ? `sample-message-${index - 1}` : null,
    role: assistant ? "assistant" : "user",
    text,
    parts: [{ type: "text", text }],
    status: "complete",
    runId: null,
    createdAt: index + 1,
    updatedAt: index + 1,
  }
})
const threads = bots.map((bot) => ({
  ...thread,
  id: bot.mainThreadId ?? "",
  botId: bot.id,
  title: "Conversa de exemplo",
  activeLeafId: messages.at(-1)?.id ?? null,
  unread: 0,
}))
const request: ApiRequest = async (route, input, path) => {
  if (route === "GET /bots") return { bots } as never
  if (route === "GET /groups") return { groups: [] } as never
  if (route === "GET /projects") return { projects: [] } as never
  if (route === "GET /browser/tabs") return { tabs: [] } as never
  if (route === "GET /workspace/activity") return { messages: [], runs: [] } as never
  if (route === "GET /bots/:id/threads")
    return { threads: threads.filter((thread) => thread.botId === path?.id) } as never
  if (route === "GET /threads/:id/messages")
    return { messages: path?.id === "sample-thread-0" ? messages : [], activeLeafId: messages.at(-1)?.id } as never
  if (route === "GET /threads/:id/runs") return { runs: [] } as never

  return mock.request(route, input, path)
}
// The workload emits distinct large replies without retaining another copy in the mock adapter.
let replies = 0
const timer = setInterval(() => {
  replies++
  const text = `${replies}: ${"Resposta simulada em segundo plano. ".repeat(2500)}`
  mock.emit({
    type: "message.updated",
    message: {
      ...message,
      id: `background-message-${replies}`,
      threadId: `sample-thread-${1 + (replies % 29)}`,
      role: "assistant",
      status: "complete",
      text,
      parts: [{ type: "text", text }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
}, 1000)
window.addEventListener("pagehide", () => clearInterval(timer), { once: true })
Object.assign(window, { getDesktopMemoryFixture: () => ({ bots: bots.length, messages: messages.length, replies }) })
localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: bots[0]?.id, threadId: threads[0]?.id }))
installMotionTokens(document.documentElement)
const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")

createRoot(root).render(<App kernel={{ services: { api: { ...mock, request } } }} />)
