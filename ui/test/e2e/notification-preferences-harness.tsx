import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
api.notify({
  kind: "approval",
  botId: "bot-mark",
  title: "Revisar arquivo",
  body: "Autorizar alteração",
  requestId: "request-demo",
})
api.notify({
  kind: "question",
  botId: "bot-mark",
  title: "Question",
  body: "Qual projeto reviso primeiro?",
  requestId: "question-demo",
})
api.notify({ kind: "done", botId: "bot-mark", title: "Done", body: "Texto bruto do modelo\nNO_NOTIFICATION" })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
