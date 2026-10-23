import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { initializeTheme } from "../../src/design/theme"
import { getRoutineChannelFixture } from "../fixtures/routine-channel"
import "../../src/styles.css"

initializeTheme()
const { api } = await getRoutineChannelFixture()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
