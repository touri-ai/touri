import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { getStreamingHistory, longAnswer } from "./streaming-history-fixture"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const thread = api.getState().threads.find((item) => item.id === "thread-mark")
if (!thread) throw new Error("Fixture conversation is missing")

const historyMode = new URLSearchParams(location.search).get("history")
const turns = historyMode === "rich" ? 250 : 13
const history = historyMode
  ? getStreamingHistory(thread.id, thread.activeLeafId ?? null, turns)
  : { messages: [], runs: [] }
if (historyMode) {
  // The mock adapter exposes mutable seed state; initialize it before the app subscribes.
  api.getState().messages.push(...history.messages)
  thread.activeLeafId = `history-answer-${turns - 1}`
}
const request: UiApi["request"] = async (route, input, pathValues, transport) => {
  const result = await api.request(route, input, pathValues, transport)
  if (!historyMode || route !== "GET /threads/:id/runs" || pathValues?.id !== thread.id) return result

  return Object.assign({}, result, { runs: history.runs })
}
const appApi = Object.assign({}, api, { request })

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
      parts: [
        {
          type: "tool_call",
          callId: "stream-command",
          tool: "exec_command",
          summary: "Conferir amostra sintética",
          inputJson: JSON.stringify({ cmd: "printf synthetic-sample" }),
          outputJson: JSON.stringify({ output: "synthetic-sample", exitCode: 0 }),
          ok: true,
        },
        { type: "text", text: "" },
      ],
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
      reply.parts = reply.parts.filter((part) => part.type !== "text").concat({ type: "text", text: reply.text })
      api.emit({ type: "message.delta", threadId: thread.id, messageId: reply.id, partIndex: 1, delta })
      if (offset < content.length) return

      window.clearInterval(timer)
      reply.status = "complete"
      api.emit({ type: "message.updated", message: { ...reply } })
      api.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: Date.now() } })
      done()
    }, interval)
  })

Object.assign(window, {
  streamingTyping: {
    stream,
    length: longAnswer.length,
    get active() {
      const reply = api.getState().messages.at(-1)
      return reply?.id === "stream-reply" && reply.status === "streaming"
    },
  },
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: appApi } }} />)
