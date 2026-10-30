import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { AvatarRuntimeProvider } from "../../src/components/AvatarRuntime"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import "../../src/styles.css"

const sender = {
  id: "bot-mark",
  name: "Atlas",
}
const message: Message = {
  id: "notice",
  threadId: "team-channel",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Publicação concluída. @pessoa, a revisão está pronta.",
  parts: [{ type: "text", text: "Publicação concluída. @pessoa, a revisão está pronta." }],
  sender,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
}
const state = createMockApi().getState()
const bots = state.bots.filter((bot) => bot.id === sender.id).map((bot) => ({ ...bot, name: sender.name }))
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <main style={{ width: "100%", maxWidth: 800, margin: "0 auto", padding: 16 }}>
      <h1>#avisos</h1>
      <AvatarRuntimeProvider
        value={{ bots, threads: [], messages: [message], runs: [], notifications: [], loading: false }}
      >
        <VirtualMessageList
          messages={[message]}
          currentPersonId="owner"
          onSwitchBranch={() => undefined}
          onRetry={async () => undefined}
        />
      </AvatarRuntimeProvider>
    </main>,
  )
