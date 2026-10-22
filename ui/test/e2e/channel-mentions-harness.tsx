import type {
  ApiRoutes,
  Bot,
  BotGroup,
  ChannelPerson,
  Message,
  NotificationRecord,
  Run,
  Thread,
} from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

type Fixture = { bots: Bot[]; group: BotGroup; thread: Thread; people: ChannelPerson[] }
type Send = ApiRoutes["POST /threads/:id/messages"]
declare global {
  interface Window {
    channelFixture: () => Promise<Fixture>
    channelSend: (
      input: Send["req"],
    ) => Promise<{ response: Send["res"]; messages: Message[]; runs: Run[]; notifications?: NotificationRecord[] }>
    channelPost: (input: Send["req"]) => Promise<void>
  }
}
const fixture = await window.channelFixture()
const base = createMockApi()
// Isolate the attention tone from the task-start tone in the ping scenario.
if (new URLSearchParams(location.search).has("notifications"))
  await base.request("PATCH /settings", { notificationPreferences: { sound: { task: false } } })
const { runs } = await base.request("GET /runs", {})
await Promise.all(runs.map((run) => base.request("POST /runs/:id/cancel", {}, { id: run.id })))
const state = base.getState()
// The mock API keeps these fixture objects; seed their identities with the real server's IDs.
fixture.bots.forEach((bot, index) => {
  const member = state.bots[index]
  if (!member) return
  if (new URLSearchParams(location.search).has("notifications")) {
    const main = state.threads.find((thread) => thread.id === member.mainThreadId)
    state.threads
      .filter((thread) => thread.botId === member.id)
      .forEach((thread) => {
        Object.assign(thread, { botId: bot.id })
      })
    if (main) Object.assign(main, { id: bot.mainThreadId })
  }
  Object.assign(member, bot)
})
const created = await base.request("POST /groups", fixture.group)
Object.assign(created.group, fixture.group)
Object.assign(created.thread, fixture.thread)
// Retain the real server's snapshot when the mock workspace reopens this channel.
const channelMessages = new Map<string, Message[]>()
const request: ApiRequest = async (route, input, path) => {
  if (route === "GET /groups/:id/people") return { people: fixture.people }
  if (route === "GET /threads/:id/messages" && path?.id === fixture.thread.id)
    return { messages: channelMessages.get(fixture.thread.id) ?? [] }
  if (route !== "POST /threads/:id/messages") return base.request(route, input, path)

  const result = await window.channelSend(input as Send["req"])
  channelMessages.set(fixture.thread.id, result.messages)
  const leaf = result.messages.at(-1)
  if (leaf) Object.assign(created.thread, { activeLeafId: leaf.id })
  result.messages.forEach((message) => {
    base.emit({ type: "message.created", message })
  })
  base.emit({ type: "thread.updated", thread: created.thread })
  result.notifications?.forEach((notification) => {
    base.emit({ type: "notification.created", notification })
  })
  result.runs.forEach((run) => {
    base.emit({ type: "run.updated", run })
  })
  return result.response as ApiRoutes[typeof route]["res"]
}
window.channelPost = async (input) => {
  await request("POST /threads/:id/messages", input, { id: fixture.thread.id })
}
localStorage.setItem("touri.sidebar.mode", new URLSearchParams(location.search).has("notifications") ? "bots" : "work")
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: { ...base, request } } }} />)
