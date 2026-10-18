import { getApiModelReference } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { BotCreateModal, BotSettingsModal } from "../../src/components/Modals"
import { SettingsModal } from "../../src/components/SettingsModal"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import type { WorkspaceActions } from "../../src/useWorkspace"
import "../../src/styles.css"

const api = createMockApi()
const Harness = () => {
  const [screen, setScreen] = useState("settings")
  const close = () => setScreen((current) => (current === "created" ? current : "home"))
  const bot = api.getState().bots[0]
  const configureBot = async () => {
    const model = (await api.request("GET /api-models", {})).models[0]
    if (!bot || !model) return
    await api.request(
      "PATCH /bots/:id",
      {
        name: "Pesquisa",
        roleLine: "Pesquisa e organização",
        provider: "opencode",
        model: getApiModelReference(model),
        projectId: null,
        cwd: null,
        folders: [],
      },
      { id: bot.id },
    )
    setScreen("bot")
  }
  const actions = {
    updateBot: async (id, patch) => {
      await api.request("PATCH /bots/:id", patch, { id })
    },
  } as WorkspaceActions
  return (
    <main>
      <nav aria-label="Demonstração">
        <button type="button" onClick={() => setScreen("settings")}>
          Configurar modelos
        </button>
        <button type="button" onClick={() => setScreen("create")}>
          Criar bot com API
        </button>
        <button type="button" onClick={() => void configureBot()}>
          Configurar bot com API
        </button>
      </nav>
      {screen === "settings" && (
        <SettingsModal
          api={api}
          settings={null}
          initialSection="api-models"
          onClose={close}
          onSave={async () => setScreen("home")}
        />
      )}
      {screen === "create" && (
        <BotCreateModal
          api={api}
          onClose={close}
          onCreate={async (input) => {
            await api.request("POST /bots", input)
            setScreen("created")
          }}
        />
      )}
      {screen === "bot" && bot && (
        <BotSettingsModal api={api} bot={bot} projects={[]} routines={[]} actions={actions} onClose={close} />
      )}
      {screen === "created" && <p>Bot de demonstração criado.</p>}
    </main>
  )
}
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
