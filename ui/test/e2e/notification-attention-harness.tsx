import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
api.notify({
  kind: "question",
  title: "Dúvida sobre o envio",
  body: "Qual canal deve receber a campanha?",
  botId: "bot-onb",
  botName: "Lia",
  threadId: "thread-onb",
  requestId: "preview-question",
})

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App kernel={{ services: { api } }} />
  </StrictMode>,
)
