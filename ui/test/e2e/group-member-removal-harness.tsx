import type { BotGroup, Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { GroupPanel } from "../../src/components/GroupPanel"
import "../../src/styles.css"
import "../../src/components/bot-panel.css"

const bot = createMockApi().getState().bots[0]
const root = document.getElementById("root")
if (!bot || !root) throw new Error("Missing fixture")
const group: BotGroup = {
  id: "team",
  name: "Equipe",
  color: bot.color,
  avatarShape: bot.avatarShape,
  avatarSeed: "team",
  memberIds: [bot.id],
  coordinatorBotId: null,
  createdAt: 1,
  updatedAt: 1,
}
const turn: Run = {
  id: "turn",
  threadId: "shared",
  botId: bot.id,
  provider: bot.provider,
  trigger: "user",
  status: "succeeded",
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: 2,
}
const result: Message = {
  id: "answer",
  threadId: "shared",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: "member",
  text: "Plano revisado. A equipe pode continuar.",
  parts: [{ type: "text", text: "Plano revisado. A equipe pode continuar." }],
  sender: { id: bot.id, name: bot.name },
  source: "local",
  createdAt: 2,
  updatedAt: 2,
}
const removed: Message = {
  ...result,
  id: "removed-notice",
  parentId: result.id,
  role: "system",
  kind: "notice",
  runId: turn.id,
  text: "O membro foi removido do grupo.",
  sender: { id: "removed", name: "Revisor" },
  parts: [{ type: "notice", code: "group_member_removed", level: "warning", text: "O membro foi removido do grupo." }],
}
createRoot(root).render(
  <main style={{ display: "grid", height: "100dvh", maxWidth: 440, margin: "0 auto" }}>
    <GroupPanel
      group={group}
      bots={[bot]}
      threadId="shared"
      messages={[result, removed]}
      runs={[turn, { ...turn, id: "member", groupTurnId: turn.id, replyMessageId: result.id }]}
      onClose={() => {}}
      onEdit={() => {}}
    />
  </main>,
)
