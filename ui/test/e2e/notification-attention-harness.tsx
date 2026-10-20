import type { Message } from "@touri/contracts"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()

const api = createMockApi()
const pending = new URLSearchParams(window.location.search).get("pending")
const approval: Message = {
  id: "preview-approval-message",
  threadId: "thread-onb",
  parentId: null,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts: [
    {
      type: "approval",
      approvalId: "preview-approval",
      request: "permission",
      detail: 'folder_access_request: {"path":"/workspace/demo","mode":"read"}',
      decision: "pending",
      scope: { source: "mcp", server: "touri", tool: "folder_access_request" },
    },
  ],
  sender: null,
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
const request: ApiRequest = async (route, input, pathValues) => {
  const response = await api.request(route, input, pathValues)
  if (pending !== "approval") return response
  if (route === "GET /workspace/activity") return { ...response, messages: [approval] }
  if (route === "GET /threads/:id/messages" && pathValues?.id === approval.threadId)
    return { ...response, messages: [approval], activeLeafId: approval.id }

  return response
}
api.notify({
  kind: pending === "approval" ? "approval" : "question",
  title: "Dúvida sobre o envio",
  body: "Qual canal deve receber a campanha?",
  botId: "bot-onb",
  threadId: "thread-onb",
  requestId: pending === "approval" ? "preview-approval" : "preview-question",
})

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App kernel={{ services: { api: { ...api, request } } }} />
  </StrictMode>,
)
