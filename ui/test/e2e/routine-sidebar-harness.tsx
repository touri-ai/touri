import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { initializeTheme } from "../../src/design/theme"
import { getRoutineSidebarFixture } from "../routine-sidebar-fixture"
import "../../src/styles.css"

initializeTheme()
const runCount = new URLSearchParams(window.location.search).get("runs") === "60" ? 60 : 28
const { api } = await getRoutineSidebarFixture(runCount)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
