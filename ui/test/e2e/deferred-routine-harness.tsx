import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()

const api = createMockApi()
const bot = api.getState().bots.find((item) => item.id === "bot-mark")
if (!bot) throw new Error("Missing bot fixture")
api.notify({
  kind: "routine-deferred",
  botId: bot.id,
  threadId: null,
  title: "Rotina adiada: Resumo da manhã",
  body: "A rotina “Resumo da manhã” não foi executada porque o touri estava fechado no horário agendado.",
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
