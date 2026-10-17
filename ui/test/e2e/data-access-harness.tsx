import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
const { bots, threads, messages } = api.getState()
const bot = bots[0]
const thread = threads.find((item) => item.botId === bot?.id)
const reply = messages[0]
if (!bot || !thread || !reply) throw new Error("Missing data fixture")
bot.name = "Dados"
bot.projectId = null
bot.homeDir = "/workspace/bot"
Object.assign(reply, {
  id: "missing-data",
  threadId: thread.id,
  role: "assistant",
  status: "complete",
  parentId: null,
  runId: null,
  text: "Para analisar os cadastros, preciso dos seus dados. Você pode anexar um CSV.\n\n<!-- touri:connect-data -->",
  parts: [],
})
messages.splice(0, messages.length, reply)
thread.activeLeafId = reply.id
const request = api.request
const unavailable = new URLSearchParams(location.search).has("unavailable")
api.request = (async (route, input, params) => {
  if (route === "GET /folders") {
    const path = (input as { path?: string }).path ?? "/workspace"
    return {
      home: "/workspace",
      path,
      parent: path === "/workspace" ? null : "/workspace",
      folders: path === "/workspace" ? [{ name: "Planilhas", path: "/workspace/Planilhas" }] : [],
      truncated: false,
      canGrant: !unavailable,
    }
  }
  return request(route, input, params)
}) as typeof api.request
Object.assign(window, { dataAccessQa: { calls: api.calls, state: api.getState } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
