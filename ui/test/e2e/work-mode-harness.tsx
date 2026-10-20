import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import { getRoutineSidebarFixture } from "../routine-sidebar-fixture"

const start = async (): Promise<void> => {
  const { api } = await getRoutineSidebarFixture(30, { todayRuns: true })
  await api.request("POST /groups", {
    name: "Planejamento",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: "bot-mark",
  })
  Object.assign(window, { workModeQa: { api } })
  installMotionTokens(document.documentElement)
  initializeTheme()

  const root = document.getElementById("root")
  if (!root) return

  createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
