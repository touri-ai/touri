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
if (scenario === "long-composer") {
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const { projects } = await api.request("GET /projects", {})
  const project = projects.find((item) => item.id === bot?.projectId)
  if (!bot || !project) throw new Error("Missing synthetic composer fixture")
  bot.model = "atlas-planning-experimental-2026-10"
  project.name = "Projeto fictício de planejamento e acessibilidade"
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
} else {
  api.notify({
    kind: "question",
    botId: "bot-mark",
    title: "Qual projeto reviso primeiro?",
    body: "Escolha a próxima tarefa.",
  })
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
