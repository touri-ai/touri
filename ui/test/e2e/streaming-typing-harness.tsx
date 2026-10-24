import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

// A long fictional answer: 60 numbered items with two sentences each and an 8-row table.
export const longAnswer = [
  "Aqui está o roteiro fictício completo, organizado por etapas:\n\n",
  ...Array.from(
    { length: 60 },
    (_, index) =>
      `${index + 1}. **Etapa ${index + 1}:** revise o item ${index + 1} da lista de viagem com calma. Depois anote o horário combinado e confirme com a equipe.\n`,
  ),
  "\n| Dia | Cidade | Atividade | Observação |\n| --- | --- | --- | --- |\n",
  ...Array.from(
    { length: 8 },
    (_, index) => `| ${index + 1} | Cidade ${index + 1} | Passeio ${index + 1} | Reservar com antecedência |\n`,
  ),
].join("")

initializeTheme()
const api = createMockApi()
const thread = api.getState().threads.find((item) => item.id === "thread-mark")
if (!thread) throw new Error("Fixture conversation is missing")

// A realistic conversation: earlier long answers (collapsed when complete) between short turns.
if (new URLSearchParams(location.search).get("history") === "realistic") {
  const start = Date.now() - 60 * 60_000
  const earlier = Array.from({ length: 13 }, (_, index) => index).flatMap((index) => {
    const at = start + index * 60_000
    const long = index % 3 === 1
    const answer = long
      ? longAnswer.replace("roteiro fictício completo", `roteiro fictício ${index}`)
      : `Resposta curta ${index}.`
    const ask: Message = {
      id: `history-ask-${index}`,
      threadId: thread.id,
      parentId: index ? `history-answer-${index - 1}` : (thread.activeLeafId ?? null),
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
    const reply: Message = {
      ...ask,
      id: `history-answer-${index}`,
      parentId: ask.id,
      role: "assistant",
      text: answer,
      parts: [{ type: "text", text: answer }],
      sender: { id: "bot-mark", name: "mark" },
      createdAt: at + 1,
      updatedAt: at + 1,
    }
    return [ask, reply]
  })
  api.getState().messages.push(...earlier)
  thread.activeLeafId = "history-answer-12"
}

const stream = ({
  interval = 30,
  size = 40,
  content = longAnswer,
}: {
  interval?: number
  size?: number
  content?: string
} = {}) =>
  new Promise<void>((done) => {
    const now = Date.now()
    const run: Run = {
      id: "stream-run",
      threadId: thread.id,
      botId: "bot-mark",
      provider: "codex",
      trigger: "user",
      requestMessageId: "stream-request",
      replyMessageId: "stream-reply",
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: now,
      startedAt: now,
      finishedAt: null,
    }
    const base = { threadId: thread.id, kind: "text", source: "local", createdAt: now, updatedAt: now } as const
    const request: Message = {
      ...base,
      id: "stream-request",
      parentId: thread.activeLeafId ?? null,
      role: "user",
      status: "complete",
      runId: null,
      text: "Faça um roteiro de 60 itens e uma tabela.",
      parts: [{ type: "text", text: "Faça um roteiro de 60 itens e uma tabela." }],
      sender: null,
    }
    const reply: Message = {
      ...base,
      id: "stream-reply",
      parentId: request.id,
      role: "assistant",
      status: "streaming",
      runId: run.id,
      text: "",
      parts: [{ type: "text", text: "" }],
      sender: { id: "bot-mark", name: "mark" },
    }
    api.getState().messages.push(request, reply)
    api.emit({ type: "message.created", message: request })
    api.emit({ type: "message.created", message: reply })
    // The conversation follows the new reply, as the server does when a turn starts.
    thread.activeLeafId = reply.id
    api.emit({ type: "thread.updated", thread: { ...thread } })
    api.emit({ type: "run.updated", run })
    let offset = 0
    const timer = window.setInterval(() => {
      const delta = content.slice(offset, offset + size)
      offset += size
      reply.text += delta
      reply.parts = [{ type: "text", text: reply.text }]
      api.emit({ type: "message.delta", threadId: thread.id, messageId: reply.id, partIndex: 0, delta })
      if (offset < content.length) return

      window.clearInterval(timer)
      reply.status = "complete"
      api.emit({ type: "message.updated", message: { ...reply } })
      api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: Date.now() } })
      done()
    }, interval)
  })

Object.assign(window, { streamingTyping: { stream, length: longAnswer.length } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
