import type { Message, ToolCallPart } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { ApiError } from "../../src/errors"
import "../../src/styles.css"

// mark's conversation has earlier history; its browser session ended while mark was still working.
initializeTheme()
const tabId = "browser-outcome-tab"
const pageUrl = "https://travel.example.test/search"
const handbacks: string[] = []
Object.assign(window, { browserOutcome: { handbacks } })

const api = createMockApi()
const state = api.getState()
const thread = state.threads.find((item) => item.id === "thread-mark")
if (!thread) throw new Error("Fixture conversation is missing")
const now = Date.now()
const text = (id: string, role: "user" | "assistant", body: string, minutesAgo: number, parentId: string | null) =>
  ({
    id,
    threadId: thread.id,
    parentId,
    role,
    kind: "text",
    status: "complete",
    runId: null,
    text: body,
    parts: [{ type: "text", text: body }],
    sender: role === "assistant" ? { id: "bot-mark", name: "mark" } : null,
    source: "local",
    createdAt: now - minutesAgo * 60_000,
    updatedAt: now - minutesAgo * 60_000,
  }) satisfies Message
const history = Array.from({ length: 6 }, (_, index) => index).flatMap((index) => {
  const parent = index === 0 ? (thread.activeLeafId ?? null) : `history-reply-${index - 1}`
  return [
    text(
      `history-user-${index}`,
      "user",
      `Pergunta fictícia ${index + 1} sobre o roteiro de viagem.`,
      60 - index * 8,
      parent,
    ),
    text(
      `history-reply-${index}`,
      "assistant",
      `Resposta fictícia ${index + 1}: separei horários, preços e observações de bagagem para comparar com calma.`,
      59 - index * 8,
      `history-user-${index}`,
    ),
  ]
})
const request = text(
  "browser-request",
  "user",
  "Abra a busca de viagem e confira as opções para Lisboa.",
  2,
  "history-reply-5",
)
const browserPart = (callId: string, tool: string, input: Record<string, unknown>): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool: `mcp__touri__${tool}`,
  summary: tool,
  inputJson: JSON.stringify(input),
  outputJson: JSON.stringify({ structured: { tabId } }),
  startedAt: now - 60_000,
  resolvedAt: now - 59_000,
  ok: true,
})
const reply: Message = {
  ...text("browser-reply", "assistant", "", 1, request.id),
  status: "streaming",
  parts: [
    { type: "text", text: "Abri a busca de viagem e estou conferindo as opções." },
    browserPart("browser-open", "browser_open", { url: pageUrl }),
    browserPart("browser-type", "browser_type", {
      tabId,
      target: { kind: "role", role: "textbox", name: "Destino" },
      text: "Lisboa",
    }),
    browserPart("browser-snapshot", "browser_snapshot", { tabId }),
  ],
}
state.messages.push(...history, request, reply)
thread.activeLeafId = reply.id

const originalRequest = api.request
api.request = (async (route: string, input?: unknown, pathValues?: Record<string, string>) => {
  if (route === "GET /browser/tabs")
    return {
      tabs: [
        {
          tabId,
          ownerBotId: "bot-mark",
          url: pageUrl,
          title: "Busca de viagem",
          state: "unloaded",
          openerTabId: null,
          heldByUser: false,
          lastUsedAt: now,
        },
      ],
    }
  if (route === "GET /bots/:id/browser-preview") return new Promise<never>(() => {})
  if (route === "POST /browser/tabs/:id/takeover/session")
    throw new ApiError(
      409,
      "Esta sessão do navegador está indisponível. Devolva o controle e peça para abrir uma página pública novamente. Nenhuma página foi reaberta.",
      "BROWSER_TAKEOVER_UNAVAILABLE",
    )
  if (route === "POST /browser/tabs/:id/takeover") {
    handbacks.push(pathValues?.id ?? "")
    return {}
  }
  return originalRequest(route as Parameters<ApiRequest>[0], input as never, pathValues)
}) as ApiRequest

const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
