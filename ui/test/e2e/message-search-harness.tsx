import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
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
const text = `nota-qa.txt: resposta antiga completa. ${"Conteúdo fictício preservado. ".repeat(24)}Fim da resposta.`
const getMessage = (index: number): Message => ({
  id: `search-history-${index}`,
  threadId: thread.id,
  parentId: index === 0 ? null : `search-history-${index - 1}`,
  role: index % 2 === 0 ? "assistant" : "user",
  kind: "text",
  status: "complete",
  text: index === 8 ? text : `Registro fictício ${index}: acompanhando o trabalho nesta conversa.`,
  parts: [
    { type: "text", text: index === 8 ? text : `Registro fictício ${index}: acompanhando o trabalho nesta conversa.` },
  ],
  runId: null,
  sender: null,
  source: "local",
  createdAt: 1_790_000_000_000 + index * 60_000,
  updatedAt: 1_790_000_000_000 + index * 60_000,
})
const history = Array.from({ length: 240 }, (_, index) => getMessage(index))
const branch: Message = {
  ...getMessage(240),
  id: "search-other-branch",
  parentId: "search-history-3",
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
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
