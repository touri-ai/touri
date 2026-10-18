import type { AppSettings, Bot, MachineState } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient, type Endpoint } from "../../src/api/client"
import { BotComputer } from "../../src/components/BotComputer"
import { BotCreateModal, SettingsModal } from "../../src/components/Modals"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import "../../src/components/bot-panel.css"

const params = new URLSearchParams(location.search)
const fixtureOrigin = params.get("fixture") ?? "http://127.0.0.1:1480"
const fixture = (await fetch(`${fixtureOrigin}/fixture?connected=${params.get("connected") ?? "true"}`).then(
  (response) => response.json(),
)) as { endpoint: Endpoint; settings: AppSettings; bot: Bot; machine: MachineState }
const api = createApiClient({ endpoint: fixture.endpoint })
const Harness = () => {
  const [settings, setSettings] = useState(fixture.settings)
  const [view, setView] = useState(params.get("view") ?? "preferences")
  return (
    <main style={{ minHeight: "100vh", padding: 32 }}>
      <div style={{ display: "flex", gap: 12 }}>
        <button type="button" className="button button-quiet" onClick={() => setView("preferences")}>
          Preferências
        </button>
        <button type="button" className="button button-quiet" onClick={() => setView("wizard")}>
          Novo bot
        </button>
        <button type="button" className="button button-quiet" onClick={() => setView("computer")}>
          Computador
        </button>
      </div>
      {view === "preferences" && (
        <SettingsModal
          api={api}
          settings={settings}
          onClose={() => setView("computer")}
          onSave={async (patch) => setSettings((await api.request("PATCH /settings", patch)).settings)}
        />
      )}
      {view === "wizard" && (
        <BotCreateModal
          api={api}
          cloudEnabled
          projects={[]}
          capability={{ available: false, reason: "Host sem virtualização", provider: null }}
          onClose={() => setView("computer")}
          onCreate={async (body) => {
            await api.request("POST /bots", body)
            setView("computer")
          }}
        />
      )}
      {view === "computer" && (
        <div className="bot-panel" style={{ margin: "40px auto", width: 720, maxWidth: "100%" }}>
          <header className="bot-panel-identity">
            <h2>Clara</h2>
            <p>Pesquisa e planejamento</p>
          </header>
          <BotComputer api={api} bot={fixture.bot} machine={fixture.machine} />
        </div>
      )}
    </main>
  )
}
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
