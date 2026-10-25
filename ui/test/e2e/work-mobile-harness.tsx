import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import { getReplyNavigationApi } from "../reply-navigation-fixture"
import { getRoutineSidebarFixture } from "../routine-sidebar-fixture"
import { installWorkBrowserFixture } from "./work-browser-fixture"

const start = async () => {
  const fixture = await getRoutineSidebarFixture(30, { todayRuns: true })
  const api = getReplyNavigationApi(fixture.api)
  await api.request("POST /groups", {
    name: "Planejamento",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: "bot-mark",
  })
  const browser = new URLSearchParams(location.search).get("browser")
  if (browser) await installWorkBrowserFixture(api, browser)
  installMotionTokens(document.documentElement)
  initializeTheme()
  const root = document.getElementById("root")
  if (!root) return

  createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
