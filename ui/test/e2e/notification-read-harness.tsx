import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()

const api = createMockApi({ scenario: "interrupted-tasks" })
api.notify({ kind: "done", title: "Resumo fictício", body: "As notas fictícias foram organizadas." })
api.notify({ kind: "notice", title: "Informação fictícia", body: "O resultado está salvo na conversa." })
api.notify({
  kind: "approval",
  title: "Revisão fictícia",
  body: "Revise a ação antes de continuar.",
  requestId: "pending-demo",
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
