import type { Message, MessagePart, Run, ToolCallPart } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { type AvatarRuntime, AvatarRuntimeProvider } from "../../src/components/AvatarRuntime"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const now = Date.now()
const tools: ToolCallPart[] = Array.from({ length: 40 }, (_, index) => ({
  type: "tool_call",
  callId: `action-${index}`,
  tool: ["Read", "exec_command", "web_search", "Edit"][index % 4] ?? "Read",
  summary: "Revisar os arquivos de exemplo",
  inputJson: index % 4 === 1 ? '{"command":"pwd"}' : '{"path":"/workspace/notas.md"}',
  outputJson: "Concluído.",
  ok: true,
}))
const parts: MessagePart[] = tools.flatMap((tool, index) => [
  { type: "reasoning", text: `Conferir etapa ${index + 1}.` },
  tool,
])
parts.push({
  type: "text",
  text: "## Revisão concluída\n\nOs 40 passos foram concluídos. As notas estão prontas para revisão.\n\n```mermaid\nflowchart LR\n  A[Revisar] --> B[Concluir]\n```",
})
const streaming = params.get("scene") === "streaming"
const waiting = params.get("scene") === "waiting" || streaming
const initial: Message = {
  id: "activity-reply",
  threadId: "activity-thread",
  parentId: "activity-request",
  role: "assistant",
  kind: "text",
  status: waiting ? "streaming" : "complete",
  runId: "activity-run",
  text: "",
  parts: streaming ? [] : waiting ? [{ type: "reasoning", text: "Conferindo o contexto da solicitação." }] : parts,
  sender: null,
  source: "local",
  createdAt: waiting ? now : now - 180_000,
  updatedAt: now,
}
const initialRun: Run = {
  id: "activity-run",
  threadId: initial.threadId,
  botId: "activity-bot",
  provider: "codex",
  trigger: "user",
  requestMessageId: "activity-request",
  replyMessageId: initial.id,
  externalTurnId: null,
  status: waiting ? "running" : "succeeded",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: initial.createdAt,
  startedAt: initial.createdAt,
  providerStartedAt: initial.createdAt,
  finishedAt: waiting ? null : now,
}
// Keep the avatar snapshot one update behind the transcript to reproduce the first-word race.
const staleRuntime: AvatarRuntime = {
  bots: [],
  threads: createMockApi()
    .getState()
    .threads.slice(0, 1)
    .map((thread) => ({ ...thread, id: initial.threadId, botId: initialRun.botId })),
  messages: [initial],
  runs: [initialRun],
  notifications: [],
  loading: false,
}
const Fixture = () => {
  const [message, setMessage] = useState(initial)
  const [run, setRun] = useState(initialRun)
  Object.assign(window, {
    chatActivity: {
      parts: (next: MessagePart[]) => setMessage((value) => ({ ...value, parts: next, updatedAt: Date.now() })),
      finish: () => {
        setMessage((value) => ({ ...value, status: "complete" }))
        setRun((value) => ({ ...value, status: "succeeded", finishedAt: Date.now() }))
      },
    },
  })
  const transcript = (
    <VirtualMessageList
      messages={[message]}
      runs={[run]}
      api={createMockApi()}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
      onCancel={async () => setRun((value) => ({ ...value, status: "canceled", finishedAt: Date.now() }))}
    />
  )
  return (
    <main
      style={{ display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 920, margin: "auto", padding: 24 }}
    >
      <h1 style={{ fontSize: 18 }}>touri · Revisão das notas</h1>
      {streaming ? <AvatarRuntimeProvider value={staleRuntime}>{transcript}</AvatarRuntimeProvider> : transcript}
    </main>
  )
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
