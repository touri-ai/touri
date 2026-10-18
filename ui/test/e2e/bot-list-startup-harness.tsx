import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

const api = createMockApi()
let release: () => void = () => undefined
const pending = new Promise<void>((resolve) => {
  release = resolve
})
const request: ApiRequest = async (route, input, path) => {
  if (route !== "GET /bots") await pending
  if (route === "GET /projects") {
    const response = await api.request("GET /projects", {})
    return {
      ...response,
      projects: response.projects.map((project) => ({
        ...project,
        path: "/workspace/projeto",
        dataDir: "/workspace/dados",
      })),
    } as never
  }
  return api.request(route, input, path)
}
Object.assign(window, { startupEvidence: { release } })
const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
createRoot(root).render(<App kernel={{ services: { api: { ...api, request } } }} />)
