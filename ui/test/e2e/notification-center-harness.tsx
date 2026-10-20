import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()

const api = createMockApi()
const { bots, threads } = api.getState()
const bot = bots.find((bot) => bot.id === "bot-mark")
const thread = threads.find((thread) => thread.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing approval fixture")
api.notify({
  kind: "approval",
  botId: bot.id,
  botName: "Ateliê",
  threadId: thread.id,
  requestId: "folder-review",
  title: "Solicitação de acesso",
  body: 'folder_access_request: {"path":"/workspace/phase-a","mode":"read-write","nextTurn":false}',
})
api.notify({
  kind: "done",
  botId: bot.id,
  botName: "Ateliê",
  threadId: thread.id,
  title: "Relatório de SEO pronto",
  body: "3 páginas com título duplicado e 1 sitemap desatualizado.",
})
api.notify({
  kind: "turn-failed",
  botId: bot.id,
  botName: "Ateliê",
  threadId: thread.id,
  title: "Não consegui concluir a alteração",
  body: "O envio foi recusado.",
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
