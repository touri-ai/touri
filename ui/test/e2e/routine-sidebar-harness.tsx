import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { initializeTheme } from "../../src/design/theme"
import { getRoutineSidebarFixture } from "../routine-sidebar-fixture"
import "../../src/styles.css"

initializeTheme()
const params = new URLSearchParams(window.location.search)
const requestedRuns = Number(params.get("runs"))
const runCount = [28, 60, 128].includes(requestedRuns) ? requestedRuns : 28
const { api } = await getRoutineSidebarFixture(runCount, {
  withOtherRoutines: params.has("otherRoutines"),
  unreadRuns: params.has("unread") ? 8 : 0,
  withoutRoutineMetadata: params.has("deleted"),
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
