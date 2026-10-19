import type { Run } from "@touri/contracts"
import { AVATAR_SHAPES } from "@touri/contracts/avatar"
import { createRoot } from "react-dom/client"
import App from "../../../src/App"
import { createMockApi } from "../../../src/api/mock"
import { BotAvatar } from "../../../src/components/BotAvatar"
import { ToolCallCard } from "../../../src/components/ToolCallCard"
import { installMotionTokens } from "../../../src/design/spring"
import "../../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
localStorage.setItem("touri.appearance.v1", params.get("theme") ?? "light")
installMotionTokens(document.documentElement)
const view = params.get("view") ?? "terminal"
const command =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal shell parameter expansion.
  'NODE_ENV=test mkdir -p ./docs/qa "$HOME/output" && printf \'%s\\n\' "${USER}" | tee ./docs/qa/result.txt'
const output =
  "\u001b[1;32m✓ Diretório criado\u001b[0m\n\u001b[34m./docs/qa/result.txt\u001b[0m\n\u001b[33mAviso: exemplo de saída\u001b[0m\n\u001b[31mErro: exemplo de mensagem\u001b[0m"
const root = document.getElementById("root")
if (!root) throw new Error("Root ausente")
if (view === "terminal") {
  createRoot(root).render(
    <main style={{ padding: 32, maxWidth: 1080, margin: "0 auto" }}>
      <h1>Terminal</h1>
      <ToolCallCard
        part={{
          type: "tool_call",
          callId: "colors",
          tool: "Bash",
          summary: "Preparar diretório e registrar resultado",
          inputJson: JSON.stringify({ command, description: "Preparar diretório e registrar resultado" }),
          outputJson: output,
          ok: true,
        }}
      />
      <div style={{ marginTop: 24 }}>
        <ToolCallCard
          part={{
            type: "tool_call",
            callId: "empty",
            tool: "Bash",
            summary: "Criar diretório vazio",
            inputJson: JSON.stringify({ command: "mkdir -p /workspace/test", description: "Criar diretório vazio" }),
            outputJson: "(Bash completed with no output)",
            ok: true,
          }}
        />
      </div>
    </main>,
  )
} else if (view === "shapes") {
  createRoot(root).render(
    <main style={{ padding: 32 }}>
      <h1>Mascotes em repouso</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 32 }}>
        {AVATAR_SHAPES.map((shape) => (
          <div key={shape} data-shape={shape} style={{ display: "grid", justifyItems: "center", gap: 12 }}>
            <div
              style={{
                width: 88,
                height: 88,
                display: "grid",
                placeItems: "center",
                background: "var(--surface-selected)",
                borderRadius: 12,
              }}
            >
              <BotAvatar bot={{ id: shape, color: "#3b93f0", avatarShape: shape }} state="idle" size={64} />
            </div>
            <small>{shape}</small>
          </div>
        ))}
      </div>
    </main>,
  )
} else {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const thread = state.threads.find((item) => item.id === "thread-mark")
  const reply = state.messages.find((item) => item.threadId === thread?.id && item.role === "assistant")
  if (!bot || !thread || !reply) throw new Error("Conversa ausente")
  bot.avatarShape = "nuage"
  bot.avatarSeed = "visual-feedback"
  bot.color = "#3b93f0"
  const runs: Run[] = []
  state.messages.splice(0, state.messages.length, reply)
  thread.activeLeafId = reply.id
  reply.text = "Vou organizar os arquivos do projeto."
  reply.parts = [{ type: "text", text: reply.text }]
  reply.updatedAt = Date.now() - 60_000
  if (view === "working") {
    reply.status = "streaming"
    reply.runId = "visual-run"
    reply.parts.push({
      type: "command",
      callId: "visual-command",
      command: "mkdir -p ./docs/qa",
      cwd: "/workspace",
      outputTail: "",
      exitCode: null,
    })
    runs.push({
      id: "visual-run",
      botId: bot.id,
      threadId: thread.id,
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: reply.id,
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    })
  } else reply.status = "complete"
  const request = api.request
  api.request = async (route, input, path) => {
    if (route === "GET /threads/:id/runs") return { runs } as never
    return request(route, input, path)
  }
  createRoot(root).render(<App kernel={{ services: { api } }} />)
}
