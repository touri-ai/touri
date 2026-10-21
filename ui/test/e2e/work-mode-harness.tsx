import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import { getRoutineSidebarFixture } from "../routine-sidebar-fixture"
import { installWorkBrowserFixture } from "./work-browser-fixture"

type FixtureApi = Awaited<ReturnType<typeof getRoutineSidebarFixture>>["api"]

const RICH_CHANNELS = [
  { name: "Geral", unread: 0 },
  { name: "Financeiro", unread: 3 },
  { name: "Marketing", unread: 12 },
  { name: "Suporte", unread: 0 },
  { name: "Produto", unread: 1 },
]

/** Six channels, five bots and unread counts, so the sidebar is judged with a realistic workspace. */
const seedRichWorkspace = async (api: FixtureApi): Promise<void> => {
  await Promise.all(
    ["Léo", "Bia"].map((name) => api.request("POST /bots", { name, provider: "claude", projectId: null } as never)),
  )
  const memberIds = ["bot-mark", "bot-onb", "bot-panko"]
  const created = await Promise.all(
    RICH_CHANNELS.map((channel) =>
      api.request("POST /groups", {
        name: channel.name,
        color: "#dc2626",
        avatarShape: "classic-none",
        memberIds,
        coordinatorBotId: "bot-mark",
      }),
    ),
  )
  const unreadByGroup = new Map(created.map((entry, index) => [entry.group.id, RICH_CHANNELS[index]?.unread ?? 0]))
  api
    .getState()
    .threads.filter((thread) => thread.groupId && unreadByGroup.has(thread.groupId))
    .forEach((thread) => {
      Object.assign(thread, { unread: unreadByGroup.get(thread.groupId ?? "") ?? 0 })
    })
}

const start = async (): Promise<void> => {
  const { api } = await getRoutineSidebarFixture(30, { todayRuns: true })
  await api.request("POST /groups", {
    name: "Planejamento",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: "bot-mark",
  })
  if (new URLSearchParams(location.search).has("rich")) await seedRichWorkspace(api)
  if (new URLSearchParams(location.search).has("large")) {
    const channels = Array.from({ length: 100 }, (_, index) => ({
      name: `Canal QA ${index + 1}`,
      color: "#dc2626",
      avatarShape: "classic-none" as const,
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    }))
    await Promise.all(channels.map((channel) => api.request("POST /groups", channel)))
  }
  const browserMode = new URLSearchParams(location.search).get("browser")
  if (browserMode) await installWorkBrowserFixture(api, browserMode)
  Object.assign(window, { workModeQa: { api } })
  installMotionTokens(document.documentElement)
  initializeTheme()

  const root = document.getElementById("root")
  if (!root) return

  createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
