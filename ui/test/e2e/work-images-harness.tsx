import type { ApiRoutes, Message } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"

const base = createMockApi()
const bot = base.getState().bots[0]
if (!bot) throw new Error("Missing synthetic bot")
const { thread } = await base.request("POST /groups", {
  name: "Capturas da equipe",
  color: "#2563eb",
  avatarShape: "classic-none",
  memberIds: [bot.id],
  coordinatorBotId: null,
})
const attachmentId = "a".repeat(64)
const getMessage = (
  id: string,
  text: string,
  parts: Message["parts"],
  role: Message["role"] = "assistant",
): Message => ({
  id,
  threadId: thread.id,
  parentId: null,
  role,
  kind: "text",
  status: "complete",
  runId: null,
  text,
  parts,
  sender:
    role === "user"
      ? { id: "audit-integration", name: "Auditoria", kind: "integration" }
      : { id: bot.id, name: "Equipe" },
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
})
const messages = [
  getMessage(
    "upload",
    "Auditoria concluída. Captura anexada.",
    [
      { type: "text", text: "Auditoria concluída. Captura anexada." },
      { type: "image", attachmentId, mime: "image/png", name: "visao-do-canal.png" },
    ],
    "user",
  ),
  getMessage("markdown", "![Tela do celular](shots/mobile.png)", [
    { type: "text", text: "![Tela do celular](shots/mobile.png)" },
  ]),
  getMessage("pattern", "Evidência: shots/round-*.png", [{ type: "text", text: "Evidência: shots/round-*.png" }]),
]
const canvas = document.createElement("canvas")
canvas.width = 720
canvas.height = 480
const drawing = canvas.getContext("2d")
if (drawing) {
  drawing.fillStyle = "#e7f3ed"
  drawing.fillRect(0, 0, 720, 480)
  drawing.fillStyle = "#165338"
  drawing.font = "bold 32px sans-serif"
  drawing.fillText("Canal da equipe", 48, 80)
  drawing.font = "24px sans-serif"
  drawing.fillText("Tarefa concluída", 48, 150)
  drawing.fillStyle = "#fff"
  drawing.fillRect(48, 200, 624, 220)
  drawing.fillStyle = "#165338"
  drawing.fillText("Captura fictícia · sem dados pessoais", 72, 260)
}
const image = await new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Missing image"))), "image/png"),
)
const baseRequest = base.request
const request: ApiRequest = async <K extends keyof ApiRoutes>(
  route: K,
  input: ApiRoutes[K]["req"],
  values: Record<string, string> = {},
): Promise<ApiRoutes[K]["res"]> => {
  if (route === "GET /attachments/:id") return image as ApiRoutes[K]["res"]
  if (route === "GET /bots/:id/images") {
    const query = input as ApiRoutes["GET /bots/:id/images"]["req"]
    if (query.path?.includes("*")) throw new Error("Unresolved image pattern")

    return image as ApiRoutes[K]["res"]
  }
  if (route === "GET /bots/:id/image-references") return { paths: ["shots/round-desktop.png"] } as ApiRoutes[K]["res"]
  if (route === "GET /threads/:id/messages" && values.id === thread.id)
    return { messages, activeLeafId: messages.at(-1)?.id ?? null } as ApiRoutes[K]["res"]
  if (route === "GET /workspace/activity") {
    const activity = await baseRequest("GET /workspace/activity", {})

    return { ...activity, messages: [...activity.messages, ...messages] } as ApiRoutes[K]["res"]
  }

  return baseRequest(route, input, values)
}
const api = { ...base, request }
localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: bot.id, threadId: thread.id, route: { section: "bots", screen: "chat" } }),
)
localStorage.setItem("touri.appearance.v1", "dark")
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<App kernel={{ services: { api } }} />)
