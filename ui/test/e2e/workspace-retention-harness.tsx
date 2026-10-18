import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createRetentionWorkload } from "../fixtures/retentionWorkload"
import "../../src/styles.css"

const workload = createRetentionWorkload()
Object.assign(window, { retentionWorkload: { round: workload.round, historyRequests: workload.historyRequests } })
const root = document.getElementById("root")
if (!root) throw new Error("Missing retention fixture root")
createRoot(root).render(<App kernel={{ services: { api: workload.api } }} />)
