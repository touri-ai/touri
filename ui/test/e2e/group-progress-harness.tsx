import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AvatarRuntimeProvider } from "../../src/components/AvatarRuntime"
import { ChatPanel } from "../../src/components/ChatPanel"
import { installMotionTokens } from "../../src/design/spring"
import { getGroupProgressFixture } from "../fixtures/groupProgress"
import "../../src/styles.css"

const fixture = getGroupProgressFixture()
const initialRuns = [fixture.coordination, fixture.execution]
const initialMessages = [fixture.request, fixture.reply]
const Fixture = () => {
  const [runs, setRuns] = useState(initialRuns)
  const [messages, setMessages] = useState(initialMessages)
  const [canceled, setCanceled] = useState<string | null>(null)
  const onCancel = async (id: string) => {
    setCanceled(id)
    setRuns((current) => current.map((run) => ({ ...run, status: "canceled", finishedAt: Date.now() })))
    setMessages((current) =>
      current.map((message) => (message.role === "assistant" ? { ...message, status: "canceled" } : message)),
    )
  }

  return (
    <AvatarRuntimeProvider
      value={{ bots: fixture.bots, threads: [fixture.thread], messages, runs, notifications: [], loading: false }}
    >
      <main style={{ height: "100dvh", display: "grid" }} data-canceled-run={canceled}>
        <ChatPanel
          api={fixture.api}
          bot={fixture.bot}
          group={{ ...fixture.group, memberIds: [fixture.bot.id] }}
          groupMembers={[fixture.bot]}
          thread={fixture.thread}
          messages={messages}
          runs={runs}
          computerGrant={null}
          onSend={async () => undefined}
          onRetry={async () => undefined}
          onCancel={onCancel}
          onSwitchBranch={async () => undefined}
          onComputerGrant={() => undefined}
          onOpenTools={() => undefined}
        />
      </main>
    </AvatarRuntimeProvider>
  )
}

installMotionTokens(document.documentElement)
document.documentElement.dataset.theme = "dark"
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
