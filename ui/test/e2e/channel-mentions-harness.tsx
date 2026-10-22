import type { ApiRoutes, Bot, BotGroup, Message, Run, Thread } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

type Fixture = { bots: Bot[]; group: BotGroup; thread: Thread }
type Send = ApiRoutes["POST /threads/:id/messages"]
declare global {
  interface Window {
    channelFixture: () => Promise<Fixture>
    channelSend: (input: Send["req"]) => Promise<{ response: Send["res"]; messages: Message[]; runs: Run[] }>
  }
}
const fixture = await window.channelFixture()
const base = createMockApi()
const state = base.getState()
fixture.bots.forEach((bot, index) => {
  const member = state.bots[index]
  if (member) Object.assign(member, bot)
})
const created = await base.request("POST /groups", fixture.group)
Object.assign(created.group, fixture.group)
Object.assign(created.thread, fixture.thread)
const request: ApiRequest = async (route, input, path) => {
  if (route !== "POST /threads/:id/messages") return base.request(route, input, path)

  const result = await window.channelSend(input as Send["req"])
  result.messages.forEach((message) => {
    base.emit({ type: "message.created", message })
  })
  result.runs.forEach((run) => {
    base.emit({ type: "run.updated", run })
  })
  return result.response as ApiRoutes[typeof route]["res"]
}
localStorage.setItem("touri.sidebar.mode", "work")
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: { ...base, request } } }} />)
