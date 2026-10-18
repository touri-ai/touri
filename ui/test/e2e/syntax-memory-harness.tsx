import type { ApiRoutes, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import "../../src/styles.css"

const startSyntaxMemoryFixture = () => {
  const mock = createMockApi()
  const template = mock.getState()
  const bot = template.bots[0]
  const thread = template.threads[0]
  const message = template.messages[0]
  const root = document.getElementById("root")
  if (!root || !bot || !thread || !message) throw new Error("Missing synthetic fixture")

  const bots = Array.from({ length: 30 }, (_, index) => ({
    ...bot,
    id: `syntax-bot-${index}`,
    name: `Exemplo ${index + 1}`,
    title: "Revisão de exemplos",
    homeDir: "/workspace",
    mainThreadId: `syntax-thread-${index}`,
    avatarSeed: `syntax-${index}`,
    sortOrder: index,
  }))
  const threads = bots.map((bot, index) => ({
    ...thread,
    id: `syntax-thread-${index}`,
    botId: bot.id,
    title: "Exemplos de código",
    activeLeafId: null,
    unread: 0,
  }))
  const messages = Array.from({ length: 60 }, (_, index) => getMessage(message, index))
  const request: ApiRequest = async (route, input, paths = {}) => {
    if (route === "GET /bots") return { bots } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots/:id/threads")
      return { threads: threads.filter((thread) => thread.botId === paths.id) } as ApiRoutes[typeof route]["res"]
    if (route === "GET /workspace/activity") return { messages: [], runs: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/runs") return { runs: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/messages")
      return {
        messages: paths.id === "syntax-thread-0" ? messages : [],
        activeLeafId: null,
      } as ApiRoutes[typeof route]["res"]

    return mock.request(route, input, paths)
  }
  localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: "syntax-bot-0", threadId: "syntax-thread-0" }))
  document.documentElement.dataset.theme = "dark"
  installMotionTokens(document.documentElement)
  createRoot(root).render(<App kernel={{ services: { api: { ...mock, request } } }} />)

  // The external event stream needs a sequence, independent of the selected conversation.
  let sequence = 0
  const timer = setInterval(() => {
    sequence += 1
    const reply = getMessage(message, sequence)
    mock.emit({
      type: "message.created",
      message: {
        ...reply,
        id: `background-${sequence}`,
        threadId: `syntax-thread-${1 + (sequence % 29)}`,
        parentId: null,
        role: "assistant",
      },
    })
  }, 1000)
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true })
}

const samples = [
  ["typescript", 'const total: number = 2\nconsole.log("exemplo", total)'],
  ["javascript", 'const total = 2\nconsole.log("exemplo", total)'],
  ["python", 'total = 2\nprint("exemplo", total)'],
  ["json", '{"exemplo": true, "total": 2}'],
  ["bash", 'total=2\nprintf "%s\\n" "$total"'],
  ["html", '<article class="exemplo">Olá</article>'],
  ["css", ".exemplo { color: red; padding: 2px; }"],
  ["sql", "SELECT nome FROM exemplos WHERE total = 2;"],
  ["yaml", "exemplo: true\ntotal: 2"],
  ["rust", 'fn main() { println!("exemplo: {}", 2); }'],
]

const getMessage = (template: Message, index: number): Message => {
  const sample = samples[Math.floor(index / 2) % samples.length]
  const text =
    index % 2 && sample
      ? `Exemplo ${Math.floor(index / 2) + 1}:\n\n\`\`\`${sample[0]}\n${sample[1]}\n\`\`\``
      : "Mostre um exemplo de código."

  return {
    ...template,
    id: `syntax-message-${index}`,
    threadId: "syntax-thread-0",
    parentId: index ? `syntax-message-${index - 1}` : null,
    role: index % 2 ? "assistant" : "user",
    status: "complete",
    runId: null,
    text,
    parts: [{ type: "text", text }],
    createdAt: 1_790_000_000_000 + index * 1000,
    updatedAt: 1_790_000_000_000 + index * 1000,
  }
}

startSyntaxMemoryFixture()
