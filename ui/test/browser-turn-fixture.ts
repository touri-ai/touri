import type { Message, Run } from "@touri/contracts"

export const getBrowserTurnMessage = (overrides: Partial<Message> = {}): Message => {
  const text = "Encontrei duas opções fictícias antes de parar."
  const status = overrides.status ?? "canceled"
  const parts: Message["parts"] = [
    {
      type: "tool_call",
      callId: "browser-read",
      tool: "browser_snapshot",
      summary: "Leu a página fictícia",
      inputJson: "{}",
      outputJson: "{}",
      ok: true,
    },
    { type: "text", text },
  ]
  const message: Message = {
    id: "browser-reply",
    threadId: "thread-mark",
    parentId: null,
    role: "assistant",
    kind: "text",
    status,
    runId: "browser-run",
    text,
    parts:
      status === "canceled"
        ? parts.concat({ type: "notice", level: "info", code: "run_canceled", text: "Cancelado por você" })
        : parts,
    sender: null,
    source: "local",
    createdAt: 1,
    updatedAt: 2,
  }

  return Object.assign({}, message, overrides)
}

export const getBrowserTurnRun = (status: Run["status"] = "canceled"): Run => ({
  id: "browser-run",
  threadId: "thread-mark",
  botId: "bot-mark",
  provider: "codex",
  trigger: "user",
  requestMessageId: null,
  replyMessageId: "browser-reply",
  externalTurnId: null,
  status,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 0,
  startedAt: 1,
  finishedAt: 2,
})
