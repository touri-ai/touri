import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { MarkdownContent } from "../../src/components/MarkdownContent"
import { ApiError } from "../../src/errors"
import "../../src/styles.css"

const query = new URLSearchParams(location.search)
document.documentElement.dataset.theme = query.get("theme") ?? "dark"
const denied = query.get("state") === "denied"
const api = createMockApi()
const bot = api.getState().bots[0]
if (!bot) throw new Error("Missing example bot")
const attachmentId = "a".repeat(64)
const canvas = document.createElement("canvas")
canvas.width = 900
canvas.height = 450
const drawing = canvas.getContext("2d")
if (drawing) {
  drawing.fillStyle = "#246447"
  drawing.fillRect(0, 0, 900, 450)
  drawing.fillStyle = "white"
  drawing.font = "bold 44px sans-serif"
  drawing.fillText("Imagem preservada no chat", 60, 160)
  drawing.font = "28px sans-serif"
  drawing.fillText("O arquivo original pode ser removido.", 60, 240)
}
const image = await new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Missing image"))), "image/png"),
)
api.request = async (route, input) => {
  if (route === "GET /bots/:id/files") throw new ApiError(403, "Denied")
  if (route === "GET /bots/:id/images" && !denied && (input as { attachmentId?: string }).attachmentId === attachmentId)
    return image as never
  throw new ApiError(403, "Denied", "IMAGE_OUTSIDE_WORKSPACE")
}
createRoot(document.getElementById("root") ?? document.body).render(
  <main style={{ maxWidth: 760, margin: "24px auto", padding: 20 }}>
    <h1>Imagens na conversa</h1>
    <p>Bot de exemplo · resposta concluída</p>
    <MarkdownContent
      evidence={{
        api,
        bot: { ...bot, machine: "local" },
        imageAttachments: denied ? [] : [{ path: "/outside/result.png", attachmentId }],
      }}
      content="Resultado: ![Arte de exemplo](/outside/result.png)"
    />
  </main>,
)
