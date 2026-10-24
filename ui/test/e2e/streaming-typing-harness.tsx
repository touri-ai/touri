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
