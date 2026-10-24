import type { Message, MessagePart, Run } from "@touri/contracts"

// A long fictional answer: 60 numbered items with two sentences each and an 8-row table.
export const longAnswer = [
  "Aqui está o roteiro fictício completo, organizado por etapas:\n\n",
  Array.from(
    { length: 60 },
    (_, index) =>
      `${index + 1}. **Etapa ${index + 1}:** revise o item ${index + 1} da lista de viagem com calma. Depois anote o horário combinado e confirme com a equipe.\n`,
  ).join(""),
  "\n| Dia | Cidade | Atividade | Observação |\n| --- | --- | --- | --- |\n",
  Array.from(
    { length: 8 },
    (_, index) => `| ${index + 1} | Cidade ${index + 1} | Passeio ${index + 1} | Reservar com antecedência |\n`,
  ).join(""),
].join("")

export const getStreamingHistory = (threadId: string, parentId: string | null = null, turns = 13) => {
  const start = Date.UTC(2026, 0, 1)
  const messages = Array.from({ length: turns }, (_, index) => {
    const at = start + index * 60_000
    const answer =
      index % 3 === 1
        ? longAnswer.replace("roteiro fictício completo", `roteiro fictício ${index}`)
        : `Resposta curta ${index}.`
    const ask: Message = {
      id: `history-ask-${index}`,
      threadId,
      parentId: index ? `history-answer-${index - 1}` : parentId,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: `Pergunta ${index}`,
      parts: [{ type: "text", text: `Pergunta ${index}` }],
      sender: null,
      source: "local",
      createdAt: at,
      updatedAt: at,
    }
    const tools: MessagePart[] = Array.from({ length: 12 }, (_, tool) => ({
      type: "tool_call",
      callId: `history-call-${index}-${tool}`,
      tool: tool % 2 ? "read_file" : "exec_command",
      summary: `Conferir amostra sintética ${index}.${tool}`,
      inputJson: JSON.stringify(
        tool % 2 ? { path: `/workspace/synthetic/sample-${index}-${tool}.md` } : { cmd: "printf synthetic-sample" },
      ),
      outputJson: JSON.stringify({ output: "Amostra sintética conferida.", exitCode: 0 }),
      ok: true,
    }))
    const reply: Message = Object.assign({}, ask, {
      id: `history-answer-${index}`,
      parentId: ask.id,
      role: "assistant" as const,
      runId: `history-run-${index}`,
      text: answer,
      parts: tools.concat({ type: "text", text: answer }),
      sender: { id: "bot-mark", name: "mark" },
      createdAt: at + 1,
      updatedAt: at + 1,
    })

    return [ask, reply]
  }).flat()
  const runs: Run[] = messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      id: message.runId ?? "",
      threadId,
      botId: "bot-mark",
      provider: "codex",
      trigger: "user",
      requestMessageId: message.parentId,
      replyMessageId: message.id,
      externalTurnId: null,
      status: "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: message.createdAt - 1,
      startedAt: message.createdAt - 1,
      finishedAt: message.updatedAt,
    }))

  return { messages, runs }
}
