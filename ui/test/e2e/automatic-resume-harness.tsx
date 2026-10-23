import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import "../../src/styles.css"

const parameters = new URLSearchParams(location.search)
const channelView = parameters.get("view") === "channel"
const pending = !channelView && parameters.get("phase") !== "before"
const requestText = channelView ? "@Relatórios prepare o relatório semanal." : "Prepare o relatório semanal."
document.documentElement.dataset.theme = parameters.get("theme") ?? "dark"
const messages: Message[] = [
  {
    id: "request",
    threadId: "demo",
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: requestText,
    parts: [{ type: "text", text: requestText }],
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "partial",
    threadId: "demo",
    parentId: "request",
    role: "assistant",
    kind: "text",
    status: "failed",
    runId: "original",
    text: "Conferi os totais e preparei a tabela. Vou terminar o relatório.",
    parts: [
      {
        type: "tool_call",
        callId: "read-report",
        tool: "Read",
        summary: "Conferir totais do relatório",
        inputJson: "{}",
        outputJson: "{}",
        ok: true,
      },
      { type: "text", text: "Conferi os totais e preparei a tabela. Vou terminar o relatório." },
      { type: "notice", level: "error", code: "run_failed", text: "timeout: A resposta foi interrompida." },
    ],
    sender: { name: "Relatórios", id: "demo-bot" },
    source: "local",
    createdAt: 2,
    updatedAt: 2,
  },
]
const run: Run = {
  id: "original",
  threadId: "demo",
  botId: "demo-bot",
  provider: "codex",
  trigger: "user",
  requestMessageId: "request",
  replyMessageId: "partial",
  externalTurnId: "turn",
  status: "failed",
  errorClass: "timeout",
  errorMessage: "Interrupted",
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: 2,
  automaticResumePending: pending,
}
const getChannelMessages = (): Message[] => {
  const partial = messages[1]
  if (!partial) return messages
  const answer = "Relatório concluído com os totais conferidos."

  return [
    ...messages,
    {
      ...partial,
      id: "visible-resume-marker",
      parentId: partial.id,
      role: "system",
      kind: "notice",
      status: "complete",
      runId: null,
      sender: null,
      text: "Retomado após falha do provedor",
      parts: [{ type: "notice", code: "run_resumed", level: "info", text: "Retomado após falha do provedor" }],
      createdAt: 3,
      updatedAt: 3,
    },
    {
      ...partial,
      id: "channel-answer",
      parentId: "visible-resume-marker",
      status: "complete",
      runId: "recovered",
      text: answer,
      parts: [{ type: "text", text: answer }],
      createdAt: 4,
      updatedAt: 4,
    },
  ]
}
const recovered: Run = {
  ...run,
  id: "recovered",
  requestMessageId: "hidden-member-request",
  replyMessageId: "channel-answer",
  groupTurnId: "channel-continuation",
  automaticResumeFromRunId: run.id,
  automaticResumePending: false,
  status: "succeeded",
  errorClass: null,
  errorMessage: null,
  queuedAt: 3,
  startedAt: 3,
  finishedAt: 4,
}
const channelTurn: Run = {
  ...run,
  id: "channel-continuation",
  requestMessageId: "visible-resume-marker",
  replyMessageId: null,
  automaticResumePending: false,
  status: "succeeded",
  errorClass: null,
  errorMessage: null,
  queuedAt: 3,
  startedAt: 3,
  finishedAt: 4,
}
const visibleMessages = channelView ? getChannelMessages() : messages
const visibleRuns = channelView ? [run, recovered, channelTurn] : [run]

const root = document.getElementById("root")
if (!root) throw new Error("Missing root")
createRoot(root).render(
  <main className="chat-panel" style={{ height: "100vh", maxWidth: 920, margin: "0 auto" }}>
    <h1 style={{ padding: 20, fontSize: 20 }}>{channelView ? "# relatórios" : "Relatório semanal"}</h1>
    <VirtualMessageList
      messages={visibleMessages}
      runs={visibleRuns}
      onSwitchBranch={async () => {}}
      onRetry={async () => {}}
      onCancel={async () => {}}
    />
  </main>,
)
