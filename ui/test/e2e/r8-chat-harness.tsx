import type { Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
installMotionTokens(document.documentElement)
const api = createMockApi()
const state = api.getState()
const thread = state.threads.find((item) => item.id === "thread-mark")
const bot = state.bots.find((item) => item.id === "bot-mark")
if (!thread || !bot) throw new Error("Conversa da fixture ausente")
bot.machine = "vm"
bot.roleLine = "Planejamento e qualidade"
thread.title = "Revisão da próxima versão"
for (const item of state.bots) {
  if (item.id === "bot-onb") item.roleLine = "Operações"
  if (item.id === "bot-panko") item.roleLine = "Pesquisa"
}
state.messages.splice(0, state.messages.length)
const now = Date.now()
const add = (role: Message["role"], text: string, overrides: Partial<Message> = {}) => {
  const message: Message = {
    id: `r8-${state.messages.length}`,
    threadId: thread.id,
    parentId: thread.activeLeafId,
    role,
    kind: "text",
    status: "complete",
    runId: null,
    text,
    parts: [{ type: "text", text }],
    sender: null,
    source: "local",
    ...(role === "user"
      ? { delivery: { clientNonce: `r8-${state.messages.length}`, deadline: now + 60_000, status: "acked" as const } }
      : {}),
    createdAt: now - (10 - state.messages.length) * 60_000,
    updatedAt: now,
    ...overrides,
  }
  state.messages.push(message)
  thread.activeLeafId = message.id
  return message
}
thread.activeLeafId = null
const view = params.get("view") ?? "conversation"
if (view === "conversation") {
  add("user", "Ajude a preparar a próxima versão. O que precisamos revisar?", { createdAt: now - 86_400_000 })
  add(
    "assistant",
    "Vamos começar pelos fluxos principais: login, busca e envio de mensagens. Depois conferimos os estados de erro.",
    { createdAt: now - 86_400_000 + 60_000 },
  )
  add("user", "Monte uma lista curta para o chat.")
  add(
    "assistant",
    "## Uma conversa fácil de acompanhar\n\n- Mensagens com hierarquia clara.\n- Respostas legíveis nos dois temas.\n- Um caminho simples para voltar à mensagem mais recente.\n\nPodemos revisar cada ponto antes de publicar.",
    { status: "canceled" },
  )
  add("user", "Perfeito. Resuma os próximos passos em três linhas.")
  add(
    "assistant",
    "**Primeiro**, revisar o espaçamento e a leitura das mensagens.\n\n**Depois**, testar navegação por teclado e conteúdo longo.\n\n**Por fim**, conferir o resultado nos temas claro e escuro.",
  )
} else if (view === "markdown") {
  add("user", "Mostre um exemplo de checklist, tabela e código.")
  add(
    "assistant",
    '## Revisão do chat\n\nA configuração fica em `ui/src/design/tokens.css`.\n\n- [x] Texto legível nos dois temas\n- [ ] Revisar os atalhos\n\n| Fluxo | Resultado | Próximo passo |\n| --- | --- | --- |\n| Enviar mensagem | Concluído | Conferir entrega |\n| Ler resposta | Em revisão | Ajustar espaçamento |\n\n### Exemplo de configuração\n\n```ts\nconst preferencias = {\n  tema: "escuro",\n  seguirNovasMensagens: true,\n}\n```\n\n> Guarde a posição de leitura ao abrir detalhes.\n\n1. Revise o fluxo principal.\n2. Confira a [documentação](https://example.test).',
    {
      parts: [
        {
          type: "reasoning",
          text: "**Plano:** conferir a hierarquia e os estados.\n\n- Revisar o texto\n- Conferir a navegação",
        },
      ],
    },
  )
} else if (view === "disclosures") {
  add("user", "Revise os arquivos do projeto e registre os resultados.")
  add("assistant", "**Arquivos revisados.** Os detalhes estão nas ferramentas abaixo.", {
    parts: [
      {
        type: "tool_call",
        callId: "r8-read",
        tool: "Read",
        summary: "Read",
        inputJson: '{"file_path":"/workspace/README.md"}',
        outputJson: Array.from({ length: 80 }, (_, index) => `Linha ${index + 1}: resultado da revisão.`).join("\n"),
        ok: true,
      },
      {
        type: "tool_call",
        callId: "r8-read-two",
        tool: "Read",
        summary: "Read",
        inputJson: '{"file_path":"/workspace/PLANO.md"}',
        outputJson: "Plano revisado.",
        ok: true,
      },
    ],
  })
} else if (view === "recovery") {
  bot.machine = "local"
  add("user", "Prepare o relatório mensal e confira os totais.")
  add("assistant", "Iniciei a conferência dos totais.", { status: "canceled" })
  add("user", "Continue de onde parou.")
  const text = "O contexto da conversa foi recuperado do histórico salvo."
  add("system", text, {
    kind: "notice",
    parts: [{ type: "notice", level: "info", code: "context_restored", text }],
  })
  add("assistant", "Retomei a conferência. O relatório mensal está concluído e os totais foram verificados.")
} else if (view === "session-recovery") {
  bot.machine = "local"
  add("user", "Prepare o relatório de demonstração.")
  add("assistant", "Etapa inicial salva.", { status: "canceled" })
  const text = "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão."
  add("system", text, {
    kind: "notice",
    parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
  })
  add("assistant", "Relatório concluído. Conferi o trabalho salvo antes de continuar.")
} else if (view === "thinking") {
  bot.machine = "local"
  add("user", "Confira o lock do payout antes de continuar.")
  add("assistant", "", {
    status: "streaming",
    parts: [
      {
        type: "reasoning",
        text: "Conferi a fila de pagamentos. Verificando o lock do payout e a ordem das operações antes de continuar…",
      },
    ],
  })
} else if (view === "long" || view === "history") {
  if (view === "history") {
    for (let index = 0; index < 18; index++) {
      add(
        index % 2 ? "assistant" : "user",
        index % 2
          ? "Conferi este fluxo. A navegação está clara e os próximos passos estão registrados."
          : `Revise o fluxo ${index / 2 + 1} desta versão.`,
      )
    }
  }
  add("user", "Liste os pontos de revisão da próxima versão.")
  add(
    "assistant",
    `## Plano de revisão\n\n${Array.from({ length: 65 }, (_, index) => `${index + 1}. Confira a navegação, o texto e os estados de erro do fluxo ${index + 1}.`).join("\n")}\n\n**Revisão concluída.**`,
  )
}

Object.assign(window, {
  r8Chat: {
    append: () => {
      const message = add(
        "assistant",
        "**Resposta final:** todos os fluxos foram revisados. Podemos seguir com a conferência visual.",
      )
      api.emit({ type: "message.created", message })
      api.emit({ type: "thread.updated", thread: { ...thread, updatedAt: Date.now() } })
    },
  },
})
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
