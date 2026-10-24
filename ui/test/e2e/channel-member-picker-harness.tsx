import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { GroupModal } from "../../src/components/GroupModal"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const names = ["Apoio equipe azul QA", "Apoio equipe verde QA"]
const bot = createMockApi().getState().bots[0]
if (!bot) throw new Error("Missing synthetic bot")
const bots = names.map((name, index) => Object.assign({}, bot, { id: `support-${index}`, name }))
const root = document.getElementById("root")

initializeTheme()
if (root)
  createRoot(root).render(
    <GroupModal
      group={null}
      bots={bots}
      channelMode
      onClose={() => {}}
      onSave={async (input) => {
        window.dispatchEvent(new CustomEvent("channel-picker-save", { detail: input }))
      }}
    />,
  )
