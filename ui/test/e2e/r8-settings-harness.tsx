import type { ApiRoutes, DoctorReport } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const api = createMockApi()
const bot = api.getState().bots.find((bot) => bot.id === "bot-mark")
if (bot) {
  bot.machine = "vm"
  bot.roleLine = "Marketing e conteúdo"
  bot.title = "Analista de conteúdo"
  bot.instructions =
    "Você ajuda a planejar campanhas e escrever conteúdo em português. Revise o contexto antes de propor uma ação."
}
const report: DoctorReport = {
  running: false,
  checkedAt: new Date("2026-10-13T18:30:00Z").getTime(),
  checks: [
    {
      id: "codex",
      label: "Codex · versão",
      status: "pass",
      ok: true,
      detail: "Provedor instalado e disponível.",
      fix: null,
    },
    {
      id: "claude-auth",
      label: "Claude · autenticação",
      status: "warn",
      ok: false,
      detail: "Conecte sua conta para usar este provedor.",
      fix: "claude auth login",
    },
    {
      id: "vm-system",
      label: "Serviço de máquinas",
      status: "fail",
      ok: false,
      detail: "O serviço está parado. Inicie para usar computadores isolados.",
      fix: "container system start",
      action: "start-machine-service",
    },
    { id: "git", label: "Git", status: "pass", ok: true, detail: "Disponível neste computador.", fix: null },
    {
      id: "network-openai-dns",
      label: "OpenAI · conexão",
      status: "pass",
      ok: true,
      detail: "DNS e conexão seguros verificados.",
      fix: null,
    },
  ],
}
const request = api.request
api.request = (async (route, input, path) => {
  if (route === "GET /doctor") return report
  if (route === "GET /bots/:id/provider-login")
    return { provider: "codex", ready: true, source: "guest", message: "Login disponível nesta máquina." }
  const result = await request(route, input, path)
  if (route === "GET /projects") {
    const response = result as ApiRoutes["GET /projects"]["res"]
    return {
      ...response,
      projects: response.projects.map((project) => ({ ...project, name: "Projeto de demonstração" })),
    }
  }
  if (route === "GET /routines") {
    const response = result as ApiRoutes["GET /routines"]["res"]
    return { ...response, routines: response.routines.map((routine) => ({ ...routine, name: "Planejamento diário" })) }
  }
  return result
}) as ApiRequest
Object.assign(window, {
  r8SettingsApi: api,
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === "server_mode_status") return { mode: "local", url: null }
      if (command === "permissions_status") return { accessibility: "denied", "screen-recording": "denied" }
      return 1
    },
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
  },
})
installMotionTokens(document.documentElement)
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
