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
type FrameRequest = { id: number; title: string; url: string } & (
  | { image: string; bitmap?: never }
  | { image?: never; bitmap: ImageBitmap }
)
type FrameResponse = { id: number; title: string; url: string; src?: string; error?: string }
const MAX_SOURCE_PIXELS = 8_000_000
const MIN_REFRESH_MS = 800

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
  options: { intervalMs?: number; onReset?: () => void } = {},
): (() => void) & { refresh: () => void } => {
  const intervalMs = options.intervalMs ?? 1_000
  const isTabPreview = bot.machine === "local" || Boolean(tabId)
  let generation = 0
  let held = false
  const lifetime = new AbortController()
  let captureController: AbortController | undefined
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let viewer: import("@novnc/novnc").default | undefined
  let socket: WebSocket | undefined
  let sessionId: string | undefined
  let frameId = 0
  let sampling = false
  let lastSampleAt = 0
  let processor: Worker | undefined
  let unsubscribe = () => {}
  let page: Pick<BrowserTabInfo, "title" | "url"> = { title: "Tela do computador", url: "" }
  const pendingFrames = new Map<
    number,
    {
      resolve: (frame: PreviewFrame) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  const clearProcessor = (): void => {
    processor?.terminate()
    processor = undefined
    pendingFrames.forEach(({ reject, timeout }) => {
      clearTimeout(timeout)
      reject(new Error("A prévia do navegador foi encerrada."))
    })
    pendingFrames.clear()
  }
  const createProcessor = (): Worker | undefined => {
    try {
      const worker = new Worker(new URL("./browser-preview.worker.ts", import.meta.url), { type: "module" })
      worker.addEventListener("message", (event) => {
        if (processor !== worker) return
        const result = (event as MessageEvent<FrameResponse>).data
        const pending = pendingFrames.get(result.id)
        if (!pending) return
        clearTimeout(pending.timeout)
        pendingFrames.delete(result.id)
        if (!result.src || result.error) {
          pending.reject(new Error(result.error ?? "A prévia do navegador não pôde ser processada."))
          return
        }
        pending.resolve({ src: result.src, title: result.title, url: result.url })
      })
      worker.addEventListener("error", () => {
        if (processor === worker) clearProcessor()
      })

      return worker
    } catch {
      return undefined
    }
  }
  processor = createProcessor()
  const processFrame = (input: Omit<FrameRequest, "id">): Promise<PreviewFrame> | null => {
    if (!processor) return null
    const id = frameId + 1
    frameId = id
    const result = new Promise<PreviewFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFrames.delete(id)
        reject(new Error("A prévia do navegador não pôde ser processada."))
        clearProcessor()
      }, 10_000)
      pendingFrames.set(id, { resolve, reject, timeout })
    })
    if ("bitmap" in input && input.bitmap) processor.postMessage({ ...input, id }, [input.bitmap])
    else processor.postMessage({ ...input, id })

    return result
  }
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
    if (!active) return
    active = false
    lifetime.abort()
    captureController?.abort()
    unsubscribe()
    unsubscribe = () => {}
    clearTimeout(timer)
    unsubscribe()
    unsubscribe = () => {}
    viewer?.disconnect()
    viewer = undefined
    socket?.close()
    socket = undefined
    clearProcessor()
    release()
    slot.replaceChildren()
  }
  const slot = document.createElement("div")
  if (!processor) {
    fail("A prévia do navegador não está disponível neste computador.")
    return Object.assign(stop, { refresh: () => {} })
  }
  const sample = async () => {
    sampling = true
    lastSampleAt = Date.now()
    const startedGeneration = generation
    captureController = new AbortController()
    try {
      if (!active || held) return
      if (!processor) return fail("A prévia do navegador não está disponível neste computador.")
      if (isTabPreview) {
        const result = await api.request(
          "GET /bots/:id/browser-preview",
          tabId ? { tabId } : {},
          { id: bot.id },
          { signal: AbortSignal.any([lifetime.signal, captureController.signal]) },
        )
        if (!active || held || generation !== startedGeneration) return
        const processed = await processFrame({ image: result.image, title: result.title, url: result.url })
        if (!active || held || generation !== startedGeneration) return
        if (!processed) return fail("A prévia do navegador não está disponível neste computador.")
        status?.(null)
        frame(processed)
      } else if (viewer) {
        const canvas = slot.querySelector("canvas")
        if (!canvas?.width || !canvas.height) {
          return
        }
        if (canvas.width * canvas.height > MAX_SOURCE_PIXELS) return fail("A prévia do navegador está muito grande.")
        const bitmap = await createImageBitmap(canvas)
        if (!active) {
          bitmap.close()
          return
        }
        const processed = await processFrame({ bitmap, ...page })
        if (!active || held || generation !== startedGeneration) return
        if (!processed) {
          bitmap.close()
          return fail("A prévia do navegador não está disponível neste computador.")
        }
        frame(processed)
      }
    } catch (error) {
      if (active && !held && generation === startedGeneration && isTabPreview) {
        if (!processor) return fail("A prévia do navegador não está disponível neste computador.")
        status?.(userFacingError(error))
      } else if (active && !held && generation === startedGeneration) fail("A prévia perdeu a conexão com a VM.")
    } finally {
      sampling = false
      if (active && !held) timer = setTimeout(() => void sample(), intervalMs)
    }
  }
  /** Grabs a frame right after an action, still one at a time and never faster than MIN_REFRESH_MS. */
  const refresh = () => {
    if (!active || held || sampling || !(isTabPreview || viewer)) return
    if (Date.now() - lastSampleAt < MIN_REFRESH_MS) return
    clearTimeout(timer)
    void sample()
  }
  const start = async () => {
    if (isTabPreview) return sample()
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
  unsubscribe = api.subscribe(({ event }) => {
    if (event.type !== "browser.tab" || event.tab.ownerBotId !== bot.id || (tabId && event.tab.tabId !== tabId)) return

    const changedPage = page.url !== event.tab.url
    page = event.tab
    generation += 1
    held = event.tab.heldByUser || event.tab.state !== "live"
    if (held || changedPage) options.onReset?.()
    if (held) {
      captureController?.abort()
      clearTimeout(timer)
      clearProcessor()
      return
    }
    if (!processor) processor = createProcessor()
    if (!sampling) {
      clearTimeout(timer)
      timer = setTimeout(() => void sample(), Math.max(0, MIN_REFRESH_MS - (Date.now() - lastSampleAt)))
    }
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
  return Object.assign(stop, { refresh })
}
