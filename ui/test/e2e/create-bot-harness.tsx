import type { ProviderLoginFlow } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const api = createMockApi()
const state = api.getState()
state.bots.splice(0)
state.threads.splice(0)
state.messages.splice(0)
const signedIn = new Set<ProviderLoginFlow["provider"]>(
  new URLSearchParams(location.search).has("signed-out") ? [] : ["codex"],
)
const request = api.request
api.request = (async (route, input, path) => {
  if (route === "GET /bots/:id/provider-login/flow") {
    const { provider } = input as { provider: ProviderLoginFlow["provider"] }
    return { provider, state: signedIn.has(provider) ? "ready" : "cancelled" }
  }
  if (route === "POST /bots/:id/provider-login/flow") {
    const { provider, action } = input as { provider: ProviderLoginFlow["provider"]; action: string }
    if (action === "start") signedIn.add(provider)
    return { provider, state: signedIn.has(provider) ? "ready" : "cancelled" }
  }
  return request(route, input, path)
}) as ApiRequest
Object.assign(window, { createBotApi: api })
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
