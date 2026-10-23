import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import "../../src/styles.css"

const sender = {
  id: "integration:notice",
  name: "touri avisos",
  avatarSeed: "integration:notice",
  kind: "integration" as const,
}
const message: Message = {
  id: "notice",
  threadId: "team-channel",
  parentId: null,
  role: "user",
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
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <main style={{ width: "100%", maxWidth: 800, margin: "0 auto", padding: 16 }}>
      <h1>#avisos</h1>
      <VirtualMessageList
        messages={[message]}
        currentPersonId="owner"
        onSwitchBranch={() => undefined}
        onRetry={async () => undefined}
      />
    </main>,
  )
