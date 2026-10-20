import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { Composer } from "../../src/components/Composer"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const seed = api.getState().bots.find((bot) => bot.id === "bot-panko")
if (!seed) throw new Error("Missing synthetic paused bot")
const locale = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "pt-BR"

const Harness = () => {
  const [paused, setPaused] = useState(true)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bot = { ...seed, name: "Touro de teste", paused }

  return (
    <main style={{ padding: 32, maxWidth: 760, margin: "auto" }}>
      <Composer
        locale={locale}
        bot={bot}
        threadId="draft:synthetic"
        parentId={null}
        api={api}
        draft={draft}
        onDraft={setDraft}
        inputRef={inputRef}
        activeRun={null}
        queuedCount={0}
        onSend={async () => undefined}
        onCancel={async () => undefined}
        onResumeBot={async () => setPaused(false)}
        autoFocus
      />
    </main>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
