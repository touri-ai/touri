import type { MachineState, McpServer, Message, RoutineRun } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const api = createMockApi()
installMotionTokens(document.documentElement)
initializeTheme()
const state = api.getState()
const scenario = new URLSearchParams(location.search).get("scenario")
const now = new Date("2026-10-13T18:30:00Z").getTime()
const bot = state.bots.find((item) => item.id === "bot-mark")
if (bot) {
  await api.request(
    "PATCH /bots/:id",
    {
      machine: "vm",
      computerUse: true,
      roleLine: "Pesquisa e planejamento",
      instructions: "Revise o contexto e apresente as fontes em português.",
    },
    { id: bot.id },
  )
}
const machine: MachineState = {
  botId: "bot-mark",
  status: "running",
  progress: null,
  error: null,
  memoryMb: 2048,
  createdMs: now,
  startMs: now,
}
for (const bot of state.bots) {
  bot.roleLine = bot.name === "mark" ? "Planejamento e conteúdo" : "Operações"
  bot.title = null
}
for (const thread of state.threads)
  thread.title = thread.botId === "bot-mark" ? "Revisão do projeto" : "Conversa principal"
const thread = state.threads.find((item) => item.id === "thread-mark")
if (!thread) throw new Error("Missing screens thread")
const base = state.messages.find((item) => item.threadId === thread.id)
if (!base) throw new Error("Missing screens message")
const markdown =
  "## Revisão do projeto\n\n**Resumo:** o servidor está pronto.\n\n- [x] Conferir a página inicial\n- [ ] Revisar as alterações\n\n[Documentação](https://example.test)"
const messages: Message[] = [
  {
    ...base,
    id: "screens-user",
    role: "user",
    parentId: null,
    text: "Confira o projeto e me avise antes de alterar arquivos.",
    parts: [],
    createdAt: now - 180_000,
  },
  {
    ...base,
    id: "screens-markdown",
    role: "assistant",
    parentId: "screens-user",
    text: markdown,
    parts: [{ type: "text", text: markdown }],
    createdAt: now - 120_000,
  },
  {
    ...base,
    id: "screens-approval",
    role: "assistant",
    parentId: "screens-markdown",
    text: "Preciso da sua aprovação para continuar a revisão.",
    parts: [
      { type: "text", text: "Preciso da sua aprovação para continuar a revisão." },
      {
        type: "approval",
        approvalId: "screens-pending",
        request: "permission",
        detail: "Read: README.md",
        decision: "pending",
        allowStanding: true,
        scope: { source: "claude", tool: "Read" },
      },
    ],
    createdAt: now - 60_000,
  },
]
state.messages.splice(0, state.messages.length, ...messages)
thread.activeLeafId = "screens-approval"
const { routines } = await api.request("GET /routines", {})
const routine = routines[0]
if (!routine) throw new Error("Missing screens routine")
routine.name = "Resumo da manhã"
routine.prompt = "Resuma as tarefas do projeto."
const runs: RoutineRun[] = []
for (const [index, name] of [
  "Revisão semanal",
  "Conferir pendências",
  "Relatório do projeto",
  "Verificar documentação",
].entries()) {
  const { routine: created } = await api.request("POST /routines", {
    ...routine,
    name,
    enabled: index === 0,
    nextRunAt: now + 86_400_000,
  } as never)
  runs.push({
    id: `screens-run-${index}`,
    routineId: created.id,
    scheduledFor: now,
    status: (["running", "running", "succeeded", "failed"] as const)[index] ?? "scheduled",
    threadId: index === 1 ? thread.id : null,
    runId: null,
    triggerSource: "cron",
    summary: null,
    startedAt: now,
    finishedAt: index > 1 ? now : null,
  })
}
api.notify({
  kind: "routine-failed",
  title: "Rotina interrompida",
  body: "A conexão foi interrompida. Você pode tentar novamente na conversa.",
  botId: "bot-mark",
  createdAt: now - 2 * 86_400_000,
})
api.notify({
  kind: "done",
  title: "Revisão concluída",
  body: "**Página inicial** revisada. Os resultados estão na conversa.",
  botId: "bot-mark",
  level: "info",
  createdAt: now - 30_000,
})
api.notify({
  kind: "approval",
  title: "Aprovação pendente",
  body: "Ler README.md para continuar a revisão.",
  requestId: "screens-pending",
  botId: "bot-mark",
  createdAt: now - 60_000,
})
const external: McpServer = {
  name: "arquivos",
  transport: "stdio",
  command: "npx",
  args: [],
  tools: [
    {
      name: "read_file",
      description: "Ler um arquivo nas pastas permitidas.",
      classification: "reads",
      policy: "always_allow",
    },
    {
      name: "write_file",
      description: "Salvar alterações em um arquivo.",
      classification: "writes",
      policy: "needs_approval",
    },
    { name: "delete_file", description: "Remover um arquivo.", classification: "writes", policy: "blocked" },
  ],
}
api.isMock = false
api.websocketUrl = () => "ws://127.0.0.1/mock-desktop"
const request = api.request.bind(api)
let failMcp = scenario === "mcp-error"
let failLogs = scenario === "logs-error"
let failConnections = scenario === "connections-error"
api.request = async (route, input, path) => {
  if (route === "GET /machines")
    return { capability: { available: true, reason: null, provider: "mock" }, machines: [machine] } as never
  if (route === "POST /bots/:id/desktop")
    return { sessionId: "r8-integrated", path: "/mock-desktop", control: false } as never
  if (route === "DELETE /desktop/:id") return {} as never
  if (route === "GET /routine-runs") return { routineRuns: runs } as never
  if (route === "GET /routines" && scenario === "empty") return { routines: [] } as never
  if (route === "GET /bots/:id/mcp") {
    if (scenario === "mcp-loading") return new Promise(() => {})
    if (failConnections) {
      failConnections = false
      throw new Error("Falha de conexão")
    }
    return { servers: scenario === "empty" ? [] : [external] } as never
  }
  if (route === "GET /mcp/tools" && scenario === "mcp-loading") return new Promise(() => {})
  if (route === "PATCH /bots/:id/mcp/:name/tools/:tool") {
    const tool = external.tools.find((item) => item.name === path?.tool)
    if (tool) Object.assign(tool, input)
    return { server: external } as never
  }
  if (route === "GET /mcp/tools" && failMcp) {
    failMcp = false
    throw new Error("Falha de conexão")
  }
  if (route === "GET /processes/:id/logs") {
    if (failLogs) {
      failLogs = false
      throw new Error("Falha de conexão")
    }
    return {
      lines: [
        "[web] Servidor iniciado na porta 4310",
        "[web] GET / 200 · 12 ms",
        "[web] GET /assets/app.css 200 · 4 ms",
        "[web] GET /favicon.svg 304 · 1 ms",
      ],
    } as never
  }
  return request(route, input, path)
}
Object.assign(window, { integratedApi: api })
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
