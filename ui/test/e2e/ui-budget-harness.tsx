import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const start = async () => {
  const approval = new URLSearchParams(location.search).has("approval")
  const browser = new URLSearchParams(location.search).has("browser")
  const baseApi = createMockApi(approval ? { scenario: "approval-notice" } : undefined)
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /groups/:id/people")
      return {
        people: [
          { id: "owner", name: "Você", avatarSeed: "owner", role: "admin" },
          { id: "person-ana", name: "Ana", avatarSeed: "person-ana", role: "member" },
        ],
      } as never
    if (route === "GET /routines") {
      const response = await baseApi.request(route, input, path)
      const routine = response.routines[0]
      if (!routine) return response as never
      return {
        ...response,
        routines: [
          routine,
          { ...routine, id: "budget-weekly", name: "Plano semanal" },
          { ...routine, id: "budget-followup", name: "Conferir pendências" },
        ],
      } as never
    }
    return baseApi.request(route, input, path)
  }
  const api = { ...baseApi, request }
  await Promise.all(
    ["Léo", "Bia", "Suporte"].map((name) =>
      api.request("POST /bots", { name, provider: "claude", projectId: null } as never),
    ),
  )
  const state = api.getState()
  const memberIds = state.bots.slice(0, 3).map((bot) => bot.id)
  const channels = await Promise.all(
    ["Viagens", "Engenharia"].map((name) =>
      api.request("POST /groups", {
        name,
        color: "#dc2626",
        avatarShape: "classic-none",
        memberIds,
        coordinatorBotId: null,
      }),
    ),
  )
  const thread = state.threads.find((entry) => entry.id === "thread-mark")
  const base = state.messages[0]
  if (!thread || !base) throw new Error("Missing budget fixture")

  const reply: Message = {
    ...base,
    id: "budget-reply",
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    status: "complete",
    text:
      "Preparei o plano da semana.\n\n### Próximos passos\n\n| Tarefa | Prazo | Responsável | Observação |\n| --- | --- | --- | --- |\n| Conferir o roteiro | Amanhã | Equipe de planejamento | Revisar os documentos antes da reunião |\n\n" +
      "Podemos revisar as opções antes de decidir.\n\n".repeat(10),
    parts: [
      ...(browser
        ? [
            {
              type: "tool_call" as const,
              callId: "budget-browser",
              tool: "mcp__touri__browser_snapshot",
              summary: "Conferir o roteiro",
              inputJson: "{}",
              outputJson: JSON.stringify({
                tabId: "budget-tab",
                url: "https://example.com",
                title: "Roteiro fictício",
              }),
              ok: true,
            },
          ]
        : []),
      ...Array.from({ length: 3 }, (_, index) => ({
        type: "command" as const,
        callId: `budget-command-${index}`,
        command: "printf 'Plano pronto'",
        exitCode: 0,
        outputTail: "Plano pronto",
      })),
      {
        type: "text",
        text:
          "Preparei o plano da semana.\n\n### Próximos passos\n\n| Tarefa | Prazo | Responsável | Observação |\n| --- | --- | --- | --- |\n| Conferir o roteiro | Amanhã | Equipe de planejamento | Revisar os documentos antes da reunião |\n\n" +
          "Podemos revisar as opções antes de decidir.\n\n".repeat(10),
      },
    ],
    runId: null,
    sender: null,
  }
  // These assignments seed the mock storage before App subscribes; no production data is read.
  Object.assign(thread, { activeLeafId: reply.id })
  state.messages.push(reply)
  const channelThread = state.threads.find((entry) => entry.groupId === channels[0]?.group.id)
  if (!channelThread) throw new Error("Missing channel fixture")

  const message: Message = {
    ...reply,
    id: "budget-person-message",
    threadId: channelThread.id,
    role: "user",
    text: "Vamos conferir o roteiro amanhã?",
    parts: [{ type: "text", text: "Vamos conferir o roteiro amanhã?" }],
    sender: { kind: "person", id: "person-ana", name: "Ana" },
  }
  state.messages.push(message)
  Object.assign(channelThread, { activeLeafId: message.id, unread: 3 })
  const emptyChannel = state.threads.find((entry) => entry.groupId === channels[1]?.group.id)
  if (emptyChannel) Object.assign(emptyChannel, { unread: 12 })
  Object.assign(window, { uiBudget: { api } })
  installMotionTokens(document.documentElement)
  initializeTheme()
  const root = document.getElementById("root")
  if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
}

void start()
