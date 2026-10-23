import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { ApiError } from "../../src/errors"
import "../../src/styles.css"

initializeTheme()
const base = createMockApi()
const request: UiApi["request"] = async (...args) => {
  if (args[0] !== "GET /threads/:id/goal") return base.request(...args)

  const response = await fetch("/goal-read", { signal: args[3]?.signal })
  if (!response.ok) throw new ApiError(response.status, "Starting")

  return base.request(...args)
}
const subscribeConnection: NonNullable<UiApi["subscribeConnection"]> = (listener) => {
  const reconnect = () => listener(true)
  window.addEventListener("goal-reconnect", reconnect)

  return () => window.removeEventListener("goal-reconnect", reconnect)
}
const api = { ...base, request, subscribeConnection }
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: "bot-mark", threadId: "thread-mark", route: { section: "bots", screen: "chat" } }),
)
const start = async () => {
  await api.request("PATCH /bots/:id", { name: "Aurora QA" }, { id: "bot-mark" })
  const root = document.getElementById("root")
  if (!root) return

  createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
