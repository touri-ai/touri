import type { Message, Thread } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

initializeTheme()
const api = createMockApi()
const state = api.getState()
const baseBot = state.bots[0]
const baseThread = state.threads[0]
if (!baseBot || !baseThread) throw new Error("Fixture de bots indisponível")
const now = Date.now()
const entries = [
  ["onb", "Onboarding", "Oi, Ana! Vamos organizar seu dia?"],
  ["seo", "SEO do site", "Há **21 arquivos `page.tsx`** para revisar."],
  ["touri-qa", "Touri · QA", "Preparei os testes de busca e os critérios de aceite."],
  ["touri-coder", "Touri · Desenvolvimento", "- **Origem:** `README.md`\n- Pronto para a próxima tarefa."],
  ["review", "Revisão de código", "Os três pontos da revisão estão resolvidos."],
  ["mail", "E-mail", "Separei as mensagens que precisam de uma resposta."],
  ["touri-pm", "Touri · Produto", "- [ ] Digitar filtro\n- [x] Conferir os resultados"],
  ["acme-pm", "Acme · Produto", "Os critérios de login estão prontos para revisar."],
  ["mobile-qa", "QA de aplicativos", "O teste foi interrompido. Podemos tentar novamente."],
  ["release", "Publicação", "Checklist de publicação revisado, sem pendências."],
] as const
state.bots.splice(0)
state.threads.splice(0)
state.messages.splice(0)
entries.forEach(([name, roleLine, text], index) => {
  const id = `sidebar-bot-${index}`
  const threadId = `sidebar-thread-${index}`
  state.bots.push({
    ...baseBot,
    id,
    name: name ?? "bot",
    roleLine,
    title: null,
    section: null,
    description: "Seu colega local.",
    avatarSeed: name ?? null,
    sortOrder: index,
    mainThreadId: threadId,
    machine: "local",
    paused: false,
  })
  const thread: Thread = {
    ...baseThread,
    id: threadId,
    botId: id,
    title: index === 2 ? "Testes de busca" : "Conversa principal",
    createdAt: now - 100_000,
    updatedAt: now - index * 60_000,
    unread: index === 4 ? 3 : 0,
    activeLeafId: `sidebar-message-${index}`,
  }
  state.threads.push(thread)
  const message: Message = {
    id: `sidebar-message-${index}`,
    threadId,
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: null,
    text: text ?? "",
    parts: [{ type: "text", text: text ?? "" }],
    sender: null,
    source: "local",
    createdAt: thread.updatedAt,
    updatedAt: thread.updatedAt,
  }
  if (index === 1)
    message.parts.push({
      type: "approval",
      approvalId: "sidebar-approval",
      request: "command",
      detail: "find . -name page.tsx",
      decision: "pending",
    })
  state.messages.push(message)
})
for (const [index, title] of ["Critérios de aceite", "Revisão da interface"].entries())
  state.threads.push({
    ...baseThread,
    id: `sidebar-qa-history-${index}`,
    botId: "sidebar-bot-2",
    title,
    kind: "main",
    activeLeafId: null,
    unread: 0,
    createdAt: now - (index + 1) * 86_400_000,
    updatedAt: now - (index + 1) * 86_400_000,
  })
api.notify({
  kind: "turn-failed",
  botId: "sidebar-bot-9",
  title: "Resposta interrompida",
  body: "Falha antiga, anterior à conclusão.",
  createdAt: now - 3 * 3_600_000,
})
api.notify({
  kind: "done",
  botId: "sidebar-bot-9",
  title: "Concluído",
  body: "Checklist de publicação revisado.",
  createdAt: now - 10_000,
})
api.notify({
  kind: "turn-failed",
  botId: "sidebar-bot-8",
  title: "Resposta interrompida",
  body: "O provedor encerrou inesperadamente. Tente novamente.",
  createdAt: now - 40_000,
})
if (new URLSearchParams(location.search).has("menus")) {
  for (const name of ["Planejamento", "Revisão", "Notas", "Pesquisa"])
    await api.request("POST /groups", {
      name,
      color: "#d64bad",
      avatarShape: "classic-none",
      memberIds: ["sidebar-bot-2", "sidebar-bot-3"],
      coordinatorBotId: null,
    })
}
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: "sidebar-bot-2", threadId: "sidebar-thread-2", route: { section: "bots", screen: "chat" } }),
)
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
