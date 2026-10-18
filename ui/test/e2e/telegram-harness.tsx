import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { ScreenHeader } from "../../src/components/ScreenPrimitives"
import { TelegramIntegrationCard } from "../../src/components/TelegramIntegrationCard"
import { t } from "../../src/i18n"
import "../../src/styles.css"
import "../../src/components/screens.css"

const api = createMockApi()
const Harness = () => {
  const [botId, setBotId] = useState("bot-a")
  return (
    <main className="workspace-screen r8-screen" style={{ maxWidth: 850, margin: "24px auto" }}>
      <ScreenHeader id="integrations" title={t("Integrações")} description="" />
      <div className="screen-content">
        <label>
          {t("Bot")}
          <select aria-label={t("Bot")} value={botId} onChange={(event) => setBotId(event.target.value)}>
            <option value="bot-a">Resumo</option>
            <option value="bot-b">Agenda</option>
          </select>
        </label>
        <div className="telegram-integration">
          <TelegramIntegrationCard api={api} botId={botId} />
        </div>
      </div>
    </main>
  )
}
const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(<Harness />)
