import type { Message, Run } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import { saveWorkspaceState } from "../../src/workspaceState"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const state = api.getState()
const thread = state.threads.find((item) => item.id === "thread-mark")
const bot = state.bots.find((item) => item.id === thread?.botId)
if (!thread || !bot) throw new Error("Missing synthetic conversation")
const scenario = new URLSearchParams(location.search).get("scenario")
const targetIndex = scenario === "recovered" || scenario === "browser-final" ? 10 : 8
const text = `nota-qa.txt: resposta antiga completa. ${"Conteúdo fictício preservado. ".repeat(scenario === "long" ? 180 : 24)}Fim da resposta.`
const isGrouped = scenario === "recovered" || scenario === "browser" || scenario === "browser-final"
const getMessage = (index: number): Message => ({
  id: `search-history-${index}`,
  threadId: thread.id,
  parentId: index === 0 ? null : `search-history-${index - 1}`,
  role: index % 2 === 0 ? "assistant" : "user",
  kind: "text",
  status: "complete",
  text: index === targetIndex ? text : `Registro fictício ${index}: acompanhando o trabalho nesta conversa.`,
  parts: [
    {
      type: "text",
      text: index === targetIndex ? text : `Registro fictício ${index}: acompanhando o trabalho nesta conversa.`,
    },
    ...(scenario?.startsWith("browser") && index === 8
      ? [
          {
            type: "tool_call" as const,
            callId: "search-browser",
            tool: "browser_snapshot",
            summary: "Conferir página fictícia",
            inputJson: "{}",
            outputJson: "{}",
            ok: true,
          },
        ]
      : []),
  ],
  runId: isGrouped && (index === 8 || index === 10) ? `search-run-${index}` : null,
  sender: null,
  source: "local",
  createdAt: 1_790_000_000_000 + index * 60_000,
  updatedAt: 1_790_000_000_000 + index * 60_000,
})
const history = Array.from({ length: 240 }, (_, index) => getMessage(index))
const runs: Run[] = isGrouped
  ? [8, 10].map((index) => ({
      id: `search-run-${index}`,
      threadId: thread.id,
      botId: bot.id,
      provider: bot.provider,
      trigger: "user",
      requestMessageId: "search-history-7",
      replyMessageId: `search-history-${index}`,
      externalTurnId: null,
      status: "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: index,
      startedAt: index,
      finishedAt: index,
      ...(scenario === "recovered" && index === 10 ? { automaticResumeFromRunId: "search-run-8" } : {}),
      ...(scenario?.startsWith("browser") ? { browserRequestId: "search-run-8" } : {}),
    }))
  : []
const request: ApiRequest = async (route, input, pathValues) =>
  route === "GET /threads/:id/runs" && pathValues?.id === thread.id && isGrouped
    ? ({ runs } as never)
    : api.request(route, input, pathValues)
const fixtureApi = { ...api, request }
const branch: Message = {
  ...getMessage(240),
  id: "search-other-branch",
  parentId: isGrouped ? "search-history-9" : "search-history-3",
  text: "Outra ramificação fictícia.",
  parts: [{ type: "text", text: "Outra ramificação fictícia." }],
}
// The mock API exposes its owned fixture arrays; seed them before React or request callbacks start.
state.messages.splice(
  0,
  state.messages.length,
  ...state.messages.filter((item) => item.threadId !== thread.id),
  ...history,
  branch,
)
Object.assign(thread, {
  title: "Revisão fictícia",
  activeLeafId: scenario === "branch" ? branch.id : "search-history-239",
  archivedAt: scenario === "archived" ? 1_790_000_000_000 : null,
})
Object.assign(bot, { name: "Brisa", title: "Revisão", roleLine: "Revisão de documentos fictícios" })
const otherBot = state.bots.find((item) => item.id === "bot-onb")
if (otherBot) Object.assign(otherBot, { name: "Oceano" })
saveWorkspaceState({
  botId: scenario === "same" || scenario === "branch" ? bot.id : "bot-onb",
  threadId: scenario === "same" || scenario === "branch" ? thread.id : "thread-onb",
})
Object.assign(window, { messageSearchFixture: { api, text } })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api: fixtureApi } }} />)
