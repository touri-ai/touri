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
if (scenario === "empty") state.bots.splice(0)
else {
  api.notify({
    kind: "question",
    botId: "bot-mark",
    title: "Qual projeto reviso primeiro?",
    body: "Escolha a próxima tarefa.",
  })
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
