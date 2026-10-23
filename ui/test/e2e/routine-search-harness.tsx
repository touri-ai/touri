import type { ApiRoutes, BotGroup } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { saveWorkspaceState } from "../../src/workspaceState"
import { getRoutineSearchFixture } from "../routine-search-fixture"
import "../../src/styles.css"

initializeTheme()
const mock = createMockApi()
const fixture = getRoutineSearchFixture()
const bot = { ...fixture.bot, name: "Lia", roleLine: "Planejamento" }
const thread = { ...fixture.thread, groupId: "planning" }
const group: BotGroup = {
  id: "planning",
  name: "Planejamento",
  color: "#dc2626",
  avatarShape: "classic-none",
  avatarSeed: "planning",
  memberIds: [bot.id],
  coordinatorBotId: null,
  createdAt: 1,
  updatedAt: 1,
}
const api: UiApi = {
  ...mock,
  isMock: false,
  request: async (route, input, params) => {
    if (route === "GET /session")
      return {
        ok: true,
        kind: "device",
        person: { id: "nina-qa", name: "Nina QA", role: "member", email: null, avatarSeed: "qa" },
      } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots") return { bots: [bot] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /groups") return { groups: [group] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /groups/:id/threads") return { threads: [thread] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots/:id/threads") return { threads: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/messages") return { messages: [] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /search") return { hits: [], threads: [] } as ApiRoutes[typeof route]["res"]

    return mock.request(route, input, params)
  },
}
saveWorkspaceState({ botId: bot.id, threadId: thread.id, route: { section: "bots", screen: "chat" } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
