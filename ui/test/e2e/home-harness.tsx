import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
Object.assign(window, { workspaceQa: { api } })
const state = api.getState()
const scenario = new URLSearchParams(location.search).get("scenario")
if (scenario === "thread-noise-before" || scenario === "thread-noise-main" || scenario === "thread-noise-grouped") {
  const bot = state.bots.find((item) => item.id === "bot-mark")
  if (!bot) throw new Error("Missing synthetic bot fixture")
  const mainThread = state.threads.find((thread) => thread.botId === bot.id)
  if (!mainThread) throw new Error("Missing synthetic main conversation fixture")
  bot.mainThreadId = mainThread.id
  bot.automaticConversationMode = scenario === "thread-noise-main" ? "main" : "task"
  const taskThreads =
    scenario === "thread-noise-main"
      ? []
      : Array.from({ length: 30 }, (_, index) => {
          const taskId = `abcdef${index.toString(16).padStart(6, "0")}`
          const createdAt = Date.now() - index * 60_000
          return {
            ...mainThread,
            id: `lead-reply-${index}`,
            kind: "chat" as const,
            title: `lead.reply · ${scenario === "thread-noise-before" ? `task-${taskId}` : taskId}`,
            activeLeafId: null,
            createdAt,
            updatedAt: createdAt,
          }
        })
  state.threads.splice(
    0,
    state.threads.length,
    ...state.threads.filter((thread) => thread.botId !== bot.id || thread.id === mainThread.id),
    ...taskThreads,
  )
}
if (scenario === "long-composer") {
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const { projects } = await api.request("GET /projects", {})
  const project = projects.find((item) => item.id === bot?.projectId)
  if (!bot || !project) throw new Error("Missing synthetic composer fixture")
  bot.provider = "opencode"
  bot.model = "touri-api-fake-481/modelo-ficticio-de-planejamento-com-contexto-extenso-2026-10"
  bot.roleLine = "Liderança de campanha"
  project.name = "Projeto fictício de planejamento e acessibilidade"
  const thread = state.threads.find((item) => item.id === "thread-mark")
  const userMessage = state.messages.find((message) => message.role === "user")
  const assistantMessage = state.messages.find((message) => message.role === "assistant")
  if (thread) thread.title = "Revisão da campanha"
  if (userMessage) userMessage.text = "Revisar a campanha"
  if (assistantMessage) assistantMessage.text = "Estou cuidando disso."
}
if (scenario === "empty") state.bots.splice(0)
else if (scenario === "failed") {
  const previous = state.messages.find((message) => message.role === "assistant")
  const thread = state.threads.find((entry) => entry.id === previous?.threadId)
  if (previous && thread) {
    previous.parentId = state.messages.find((message) => message.role === "user")?.id ?? null
    const failed = {
      ...previous,
      id: "failed-task-reply",
      parentId: previous.id,
      runId: "failed-task-run",
      status: "failed" as const,
      text: "",
      parts: [
        { type: "notice" as const, level: "error" as const, code: "run_failed", text: "cli_auth: session expired" },
      ],
      createdAt: previous.createdAt + 1,
    }
    state.messages.push(failed)
    thread.activeLeafId = failed.id
  }
} else if (!scenario?.startsWith("thread-noise-")) {
  api.notify({
    kind: "question",
    botId: "bot-mark",
    title: "Qual projeto reviso primeiro?",
    body: "Escolha a próxima tarefa.",
  })
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
