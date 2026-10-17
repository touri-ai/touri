import type { ApprovalPart, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const { bots, threads, messages } = api.getState()
const bot = bots.find((bot) => bot.id === "bot-mark")
const thread = threads.find((thread) => thread.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing approval fixture")
bot.name = "Café Ideias"
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "folder-review",
  request: "permission",
  scope: { source: "mcp", server: "touri", tool: "folder_access_request" },
  detail:
    'folder_access_request: {"path":"/workspace/phase-a","requestedPath":"/workspace/alias","mode":"read-write","previousMode":null,"nextTurn":false}',
  decision: "pending",
}
const reply: Message = {
  id: "folder-review-message",
  threadId: thread.id,
  parentId: thread.activeLeafId,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts: [approval],
  sender: null,
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
messages.push(reply)
thread.activeLeafId = reply.id
api.notify({
  kind: "approval",
  botId: bot.id,
  threadId: thread.id,
  requestId: approval.approvalId,
  title: "Approve action",
  body: approval.detail,
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
