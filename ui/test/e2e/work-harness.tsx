import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { initializeTheme } from "../../src/design/theme"
import { createChannelWorkApi } from "../fixtures/channel-work-api"
import { createWorkApi } from "../fixtures/work-api"
import "../../src/styles.css"

initializeTheme()
const api = new URLSearchParams(location.search).has("channel-queue") ? createChannelWorkApi() : createWorkApi()
Object.assign(window, { workQa: { finishFirst: api.finishFirst } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
