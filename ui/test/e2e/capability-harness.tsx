import type { ApprovalPart, Message, ToolCallPart } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const { bots, threads, messages } = api.getState()
const bot = bots[0]
const thread = threads.find((item) => item.botId === bot?.id)
const template = messages[0]
if (!bot || !thread || !template) throw new Error("Missing fixture")
const computer = new URLSearchParams(location.search).has("computer")
thread.title = computer ? "Tarefa na tela" : "Página solicitada"
bot.name = "Lia"
bot.browserEnabled = false
bot.computerUse = false
bot.projectId = null
bot.homeDir = "/workspace/bot"
const input = {
  capability: computer ? "computer_use" : "browser",
  reason: computer ? "concluir a tarefa na tela" : "abrir a página solicitada",
}
const tool: ToolCallPart = {
  type: "tool_call",
  callId: "request",
  tool: "mcp__touri__capability_request",
  summary: "capability_request",
  inputJson: JSON.stringify(input),
  outputJson: null,
  ok: null,
}
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "capability",
  botId: bot.id,
  request: "permission",
  scope: { source: "mcp", server: "touri", tool: "capability_request" },
  detail: `capability_request: ${JSON.stringify({ ...input, botName: bot.name, machine: "local", hostComputerUse: false })}`,
  allowStanding: false,
  decision: "pending",
}
const user: Message = {
  ...template,
  id: "original-task",
  threadId: thread.id,
  role: "user",
  text: computer
    ? "Conclua a tarefa na tela. Pode ativar seu controle do computador."
    : "Abra https://example.test/reference. Pode ativar seu navegador.",
  parts: [],
  parentId: null,
  runId: null,
  status: "complete",
}
const reply: Message = {
  ...template,
  id: "request-access",
  threadId: thread.id,
  role: "assistant",
  text: "",
  parts: [tool, approval],
  parentId: user.id,
  runId: null,
  status: "streaming",
}
messages.splice(0, messages.length, user, reply)
thread.activeLeafId = reply.id
const opened: string[] = []
const request = api.request
api.request = (async (route, args, params) => {
  const result = await request(route, args, params)
  if (route === "POST /approvals/:id") {
    const enabled = (args as { decision: string }).decision === "approved"
    if (enabled) {
      if (computer) bot.computerUse = true
      else {
        bot.browserEnabled = true
        opened.push("https://example.test/reference")
      }
      api.emit({ type: "bot.updated", bot: { ...bot } })
    }
    reply.status = "complete"
    api.emit({ type: "message.updated", message: { ...reply } })
    const text = enabled
      ? "Acesso ativado. Continuei a tarefa solicitada."
      : "Tudo bem. Você pode ativar depois nas configurações deste bot."
    const completed: Message = {
      ...reply,
      id: "task-result",
      parentId: reply.id,
      text,
      parts: [{ type: "text", text }],
      status: "complete",
    }
    messages.push(completed)
    thread.activeLeafId = completed.id
    api.emit({ type: "message.created", message: completed })
    api.emit({ type: "thread.updated", thread: { ...thread } })
  }
  return result
}) as typeof api.request
Object.assign(window, { capabilityQa: { calls: api.calls, state: api.getState, opened } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
