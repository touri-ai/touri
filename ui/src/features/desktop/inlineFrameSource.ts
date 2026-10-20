import type { Bot, BrowserTabInfo } from "@touri/contracts"
import type { UiApi } from "../../api/client"
import { userFacingError } from "../../errors"
import { withTimeout } from "./withTimeout"

/** `src` is a data: URL: the desktop CSP allows data: images and deliberately blocks blob: ones. */
export type PreviewFrame = { src: string; title: string; url: string }

const SESSION_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const SESSION_TIMEOUT_MESSAGE = "A VM não respondeu ao pedido da prévia em 20 s. Confira se a máquina está ligada."
const HANDSHAKE_TIMEOUT_MESSAGE =
  "A VM não entregou a primeira imagem em 15 s. Use Abrir no Computador para reconectar."
const FRAME_TYPE = "image/jpeg"
const FRAME_QUALITY = 0.65

/** Decodes a data: URL without fetch(), which the desktop CSP (connect-src) refuses for data: URLs. */
export const dataUrlBlob = (value: string): Blob => {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) throw new Error("A prévia recebeu uma imagem inválida.")
  const [, type = "application/octet-stream", base64, payload = ""] = match
  if (!base64) return new Blob([decodeURIComponent(payload)], { type })
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

export const startInlineFrameSource = (
  api: UiApi,
  bot: Pick<Bot, "id" | "machine">,
  tabId: string | undefined,
  frame: (value: PreviewFrame) => void,
  unavailable: (reason?: string) => void,
  status?: (message: string | null) => void,
  options: { intervalMs?: number } = {},
): (() => void) => {
  const intervalMs = options.intervalMs ?? 1_000
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let viewer: import("@novnc/novnc").default | undefined
  let socket: WebSocket | undefined
  let sessionId: string | undefined
  let page: Pick<BrowserTabInfo, "title" | "url"> = { title: "Tela do computador", url: "" }
  const release = () => {
    const id = sessionId
    sessionId = undefined
    if (id) void api.request("DELETE /desktop/:id", {}, { id }).catch(() => {})
  }
  const fail = (reason?: string) => {
    if (!active) return
    unavailable(reason)
    stop()
  }
  const stop = () => {
    active = false
    clearTimeout(timer)
    viewer?.disconnect()
    viewer = undefined
    socket?.close()
    socket = undefined
    release()
    buffer.width = buffer.height = source.width = source.height = 0
    slot.replaceChildren()
  }
  const slot = document.createElement("div")
  const source = document.createElement("canvas")
  const buffer = document.createElement("canvas")
  buffer.width = 640
  buffer.height = 400
  const sample = async () => {
    try {
      if (!active) return
      if (bot.machine === "local") {
        const result = await api.request("GET /bots/:id/browser-preview", tabId ? { tabId } : {}, { id: bot.id })
        if (!active) return
        const bitmap = await createImageBitmap(dataUrlBlob(result.image))
        try {
          if (!active) return
          const ctx = buffer.getContext("2d")
          if (!ctx) return fail("O navegador não conseguiu desenhar a prévia.")
          status?.(null)
          ctx.clearRect(0, 0, 640, 400)
          const ratio = Math.min(640 / bitmap.width, 400 / bitmap.height)
          const width = bitmap.width * ratio
          const height = bitmap.height * ratio
          ctx.drawImage(bitmap, (640 - width) / 2, (400 - height) / 2, width, height)
          frame({ src: buffer.toDataURL(FRAME_TYPE, FRAME_QUALITY), title: result.title, url: result.url })
        } finally {
          bitmap.close()
        }
      } else if (viewer) {
        const image = viewer.getImageData()
        if (!image.width || !image.height || !image.data.some((value, index) => index % 4 === 3 && value)) {
          timer = setTimeout(() => void sample(), intervalMs)
          return
        }
        source.width = image.width
        source.height = image.height
        source.getContext("2d")?.putImageData(image, 0, 0)
        const ctx = buffer.getContext("2d")
        if (!ctx) return fail("O navegador não conseguiu desenhar a prévia.")
        ctx.clearRect(0, 0, 640, 400)
        const ratio = Math.min(640 / image.width, 400 / image.height)
        const width = image.width * ratio
        const height = image.height * ratio
        ctx.drawImage(source, (640 - width) / 2, (400 - height) / 2, width, height)
        frame({ src: buffer.toDataURL(FRAME_TYPE, FRAME_QUALITY), ...page })
      }
      if (active) timer = setTimeout(() => void sample(), intervalMs)
    } catch (error) {
      if (active && bot.machine === "local") {
        status?.(userFacingError(error))
        timer = setTimeout(() => void sample(), intervalMs)
      } else fail("A prévia perdeu a conexão com a VM.")
    }
  }
  const start = async () => {
    if (bot.machine === "local") return sample()
    if (!api.websocketUrl || api.isMock) return fail("A conexão com o computador está indisponível.")
    const { default: RFB } = await import("@novnc/novnc")
    if (!active) return
    const session = await withTimeout({
      work: api.request("POST /bots/:id/desktop", { control: false, preview: true }, { id: bot.id }),
      ms: SESSION_TIMEOUT_MS,
      message: SESSION_TIMEOUT_MESSAGE,
    })
    sessionId = session.sessionId
    if (!active) return release()
    const socketUrl = await withTimeout({
      work: Promise.resolve(api.websocketUrl(session.path)),
      ms: SESSION_TIMEOUT_MS,
      message: SESSION_TIMEOUT_MESSAGE,
    })
    if (!active) return
    socket = new WebSocket(socketUrl)
    socket.binaryType = "arraybuffer"
    viewer = new RFB(slot, socket, { shared: true })
    viewer.viewOnly = true
    viewer.resizeSession = false
    viewer.focusOnClick = false
    viewer.addEventListener("connect", () => {
      clearTimeout(timer)
      void sample()
    })
    viewer.addEventListener("disconnect", () => fail("A conexão da prévia com a VM foi encerrada."))
    viewer.addEventListener("securityfailure", () => fail("A VM recusou a conexão da prévia."))
    timer = setTimeout(() => fail(HANDSHAKE_TIMEOUT_MESSAGE), HANDSHAKE_TIMEOUT_MS)
  }
  // Metadata events share the viewer's existing browser tab pipeline.
  const unsubscribe = api.subscribe(({ event }) => {
    if (event.type === "browser.tab" && event.tab.ownerBotId === bot.id && (!tabId || event.tab.tabId === tabId))
      page = event.tab
  })
  void api
    .request("GET /browser/tabs", { botId: bot.id })
    .then(({ tabs }) => {
      const tab = tabs
        .filter((tab) => tab.state === "live" && (!tabId || tab.tabId === tabId))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
      if (active && tab) page = tab
    })
    .catch(() => {})
  void start().catch((error: unknown) => fail(userFacingError(error)))
  return () => {
    stop()
    unsubscribe()
  }
}
