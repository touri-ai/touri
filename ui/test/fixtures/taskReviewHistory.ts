import type { Message, Run } from "@touri/contracts"

export const getTaskReviewHistory = ({
  threadId,
  botId,
  now,
  hasLaterReply = true,
  longHistory = false,
}: {
  threadId: string
  botId: string
  now: number
  hasLaterReply?: boolean
  longHistory?: boolean
}): { messages: Message[]; run: Run } => {
  const runId = "review-interrupted-run"
  const text = getReplyText("Etapa registrada", longHistory)
  const failed: Message = {
    id: "review-failed-reply",
    threadId,
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "failed",
    runId,
    text,
    parts: [
      { type: "text", text },
      {
        type: "command",
        callId: "review-command",
        command: "ls notas/",
        cwd: ".",
        exitCode: null,
        outputTail: "",
        resolution: "interrupted",
      },
      {
        type: "file_change",
        callId: "review-saved-file",
        paths: ["review-notes.md"],
        diff: null,
        completedOutcome: "succeeded",
      },
      { type: "notice", level: "error", code: "run_failed", text: "app_restart" },
    ],
    sender: null,
    source: "local",
    createdAt: now - 3000,
    updatedAt: now - 2000,
  }
  const laterText = getReplyText("Resposta posterior", longHistory)
  const later: Message = {
    id: "review-later-reply",
    threadId,
    parentId: failed.id,
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: null,
    text: laterText,
    parts: [{ type: "text", text: laterText }],
    sender: null,
    source: "local",
    createdAt: now - 1000,
    updatedAt: now - 1000,
  }
  const run: Run = {
    id: runId,
    threadId,
    botId,
    provider: "codex",
    trigger: "user",
    requestMessageId: "review-saved-request",
    replyMessageId: failed.id,
    externalTurnId: null,
    status: "interrupted",
    errorClass: "app_restart",
    errorMessage: "app_restart",
    usage: null,
    routineRunId: null,
    queuedAt: now - 4000,
    startedAt: now - 3000,
    finishedAt: now - 2000,
  }

  return { messages: hasLaterReply ? [failed, later] : [failed], run }
}

const getReplyText = (label: string, longHistory: boolean): string => {
  if (!longHistory) return `${label} da tarefa fictícia.`

  return Array.from(
    { length: 18 },
    (_, index) => `${label} ${index + 1}: conteúdo fictício para revisar o histórico e conferir as ações salvas.`,
  ).join("\n\n")
}
