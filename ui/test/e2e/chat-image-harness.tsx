import type { Message } from "@touri/contracts"
import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { createMockApi } from "../../src/api/mock"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import { EvidenceContext } from "../../src/components/EvidenceGallery"
import "../../src/styles.css"

const theme = new URLSearchParams(location.search).get("theme") ?? "dark"
document.documentElement.dataset.theme = theme
Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })

const makeMockImage = (width: number, height: number, label: string, tint: string): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) {
      reject(new Error("Canvas indisponível"))
      return
    }
    context.fillStyle = "#f2f4f7"
    context.fillRect(0, 0, width, height)
    context.fillStyle = tint
    context.fillRect(32, 32, width - 64, 76)
    context.fillStyle = "#ffffff"
    context.fillRect(32, 140, width - 64, Math.max(180, height * 0.32))
    context.fillStyle = "#28303b"
    context.font = `bold ${Math.max(30, Math.floor(width / 26))}px sans-serif`
    context.fillText(label, 52, 92)
    context.fillStyle = "#cbd2dc"
    for (let index = 0; index < 6; index++) context.fillRect(56, 184 + index * 52, width * 0.54, 18)
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Imagem de exemplo indisponível"))), "image/png")
  })

const makeMessage = (index: number, role: Message["role"], text: string, createdAt: number): Message => ({
  id: index === 110 ? "image-reply" : `history-${index}`,
  threadId: "image-thread",
  parentId: null,
  role,
  kind: "text",
  status: "complete",
  runId: null,
  text,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt,
  updatedAt: createdAt,
})

const now = Date.now()
const imageReply = [
  "[Baixar imagem](/mock/mobile.png)",
  "![mobile](/mock/mobile.png)",
  "[Baixar imagem](/mock/desktop.png)",
  "![desktop](/mock/desktop.png)",
].join("\n\n")
const messages = [
  ...Array.from({ length: 110 }, (_, index) =>
    makeMessage(
      index,
      index % 2 === 0 ? "user" : "assistant",
      `Mensagem de exemplo ${index + 1}.`,
      now - 110_000 + index * 1_000,
    ),
  ),
  makeMessage(110, "assistant", imageReply, now),
]

const Fixture = () => {
  const [images, setImages] = useState<Map<string, Blob> | null>(null)
  useEffect(() => {
    void Promise.all([
      makeMockImage(1170, 2532, "MOBILE · EXEMPLO", "#c9d9fa"),
      makeMockImage(2880, 1800, "DESKTOP · EXEMPLO", "#d8eadb"),
    ]).then(([mobile, desktop]) =>
      setImages(
        new Map([
          ["/mock/mobile.png", mobile],
          ["/mock/desktop.png", desktop],
        ]),
      ),
    )
  }, [])
  if (!images) return null

  const api = createMockApi()
  api.request = async (route, input) => {
    if (route !== "GET /bots/:id/images") throw new Error("Rota inesperada no exemplo")
    const path = typeof (input as { path?: unknown }).path === "string" ? (input as { path: string }).path : ""
    return (images.get(path) ?? new Blob([], { type: "image/png" })) as never
  }
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Bot de exemplo indisponível")

  return (
    <EvidenceContext.Provider value={{ api, bot }}>
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100dvh",
          maxWidth: 960,
          margin: "auto",
          padding: 24,
        }}
      >
        <header style={{ paddingBottom: 12, color: "var(--text-primary)" }}>Conversa de exemplo</header>
        <VirtualMessageList
          messages={messages}
          api={api}
          onSwitchBranch={() => undefined}
          onRetry={async () => undefined}
        />
        <footer
          style={{
            height: 68,
            flexShrink: 0,
            border: "1px solid var(--border-default)",
            borderRadius: 18,
            background: "var(--surface-panel)",
          }}
        />
      </main>
    </EvidenceContext.Provider>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
