import type { RoutineRun } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const { routines } = await api.request("GET /routines", {})
const routine = routines[0]
if (!routine) throw new Error("Missing routine fixture")

const routineRuns: RoutineRun[] = [
  "o atraso ultrapassou a janela de recuperação.",
  "o touri não estava em execução no horário agendado.",
].map((reason, index) => ({
  id: `routine-catchup-${index}`,
  routineId: routine.id,
  scheduledFor: Date.now() - (index + 1) * 15 * 60_000,
  status: "skipped",
  threadId: null,
  runId: null,
  triggerSource: "catch-up",
  summary: `Rotina “${routine.name}” não executada: ${reason}`,
  startedAt: null,
  finishedAt: Date.now(),
}))
const request: typeof api.request = async (route, input, path) => {
  if (route === "GET /routine-runs") return { routineRuns } as never

  return api.request(route, input, path)
}
const fixtureApi = Object.assign({}, api, { request })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: fixtureApi } }} />)
