import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi({ scenario: "approval-notice" })
if (new URLSearchParams(location.search).has("pending-question"))
  api.notify({
    kind: "question",
    botId: "bot-mark",
    threadId: "thread-mark",
    requestId: "question-review",
    title: "Escolha uma opção",
    body: "Qual tarefa deve continuar?",
  })
Object.assign(window, {
  approvalNoticeFixture: {
    resolve: () =>
      api.request(
        "POST /threads/:id/respond",
        { requestId: "folder-review", behavior: "allow" },
        { id: "thread-mark-approval" },
      ),
    echo: () =>
      api.emit({
        type: "notify",
        level: "warning",
        title: "Café Ideias: Ação pendente",
        body: 'folder_access_request: {"path":"/workspace/phase-a","requestedPath":"/workspace/alias","mode":"read-write","previousMode":null,"nextTurn":false}',
        threadId: "thread-mark-approval",
      }),
  },
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
