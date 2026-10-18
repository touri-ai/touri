import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { BotCreateModal } from "../../src/components/Modals"
import { SettingsModal } from "../../src/components/SettingsModal"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const api = createMockApi()
const Harness = () => {
  const [screen, setScreen] = useState("settings")
  return (
    <main>
      <nav aria-label="Demonstração">
        <button type="button" onClick={() => setScreen("settings")}>
          Configurar modelos
        </button>
        <button type="button" onClick={() => setScreen("create")}>
          Criar bot com API
        </button>
      </nav>
      {screen === "settings" && (
        <SettingsModal
          api={api}
          settings={null}
          initialSection="api-models"
          onClose={() => setScreen("home")}
          onSave={async () => setScreen("home")}
        />
      )}
      {screen === "create" && (
        <BotCreateModal
          api={api}
          onClose={() => setScreen("home")}
          onCreate={async (input) => {
            await api.request("POST /bots", input)
            setScreen("created")
          }}
        />
      )}
      {screen === "created" && <p>Bot de demonstração criado.</p>}
    </main>
  )
}
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
