import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const scene = new URLSearchParams(location.search).get("scene")
const api = createMockApi()
const request = api.request
const requestWithScene = (async (route, input, path) => {
  if (scene === "onboarding" && route === "GET /bots") return { bots: [] }
  if (scene === "menu" && route === "GET /projects") {
    const response = await api.request("GET /projects", {})
    const project = response.projects[0]
    if (!project) return response

    return {
      projects: Array.from({ length: 32 }, (_, index) => ({
        ...project,
        id: `demo-project-${index}`,
        name: `Projeto de demonstração ${index + 1}`,
      })),
    }
  }
  return request(route, input, path)
}) as ApiRequest

// Replace native IPC in this browser fixture without connecting to a real service.
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === "server_mode_status") return { mode: "local", url: null }
      if (command === "sidecar_endpoint" && scene === "loading") return new Promise(() => undefined)
      if (command === "sidecar_endpoint") throw new Error("TOURI-E1009")
      return 1
    },
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
  },
})

if (scene === "notice") {
  setTimeout(() => api.emit({ type: "notify", title: "Conexão interrompida", body: "TOURI-E1009" }), 500)
}

initializeTheme()
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <App
      kernel={
        scene === "error" || scene === "loading"
          ? undefined
          : { services: { api: { ...api, request: requestWithScene } } }
      }
    />,
  )
