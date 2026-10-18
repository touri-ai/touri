import type { Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { ActivityMark } from "../../src/components/ActivityMark"
import { DeleteBotDialog } from "../../src/components/DeleteBotDialog"
import { BotCreateModal } from "../../src/components/Modals"
import { CREATE_PROVIDERS } from "../../src/features/bots/useCreateProvider"
import "../../src/styles.css"

const api = createMockApi()
const bot = api.getState().bots[0]
if (!bot) throw new Error("Missing bot")
bot.name = "Caderno"
bot.machine = "vm"
const params = new URLSearchParams(location.search)
if (params.has("account")) {
  let settle: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    settle = resolve
  })
  const original = api.request
  api.request = (async (route, input, path) => {
    if (route === "GET /health") return { ok: true, version: "test", schemaVersion: 1, host: "mac" }
    if (route === "GET /bots/:id/provider-login/flow") {
      if (input.provider !== CREATE_PROVIDERS[0]) throw new Error("unavailable account")
      await pending
      return { provider: CREATE_PROVIDERS[0], state: "ready", executable: "available", host: "mac" }
    }
    return original(route, input, path)
  }) as ApiRequest
  Object.assign(window, { settleAccount: settle })
}
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    params.has("account") ? (
      <BotCreateModal api={api} onClose={() => {}} onCreate={async () => {}} />
    ) : params.has("waiting") ? (
      <ActivityMark
        state="thinking"
        preparingEnvironment
        run={
          {
            id: "waiting",
            status: "starting",
            queuedAt: Date.now() - 45_000,
            startedAt: Date.now() - 45_000,
            providerStartedAt: null,
          } as Run
        }
      />
    ) : (
      <DeleteBotDialog bot={bot} onClose={() => {}} onDelete={async () => {}} />
    ),
  )
