import type { Bot, UiEventEnvelope } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { startInlineFrameSource } from "../src/features/desktop/inlineFrameSource"

const mock = vi.hoisted(() => ({
  viewers: [] as Array<
    EventTarget & {
      viewOnly: boolean
      resizeSession: boolean
      focusOnClick: boolean
      disconnect: ReturnType<typeof vi.fn>
      sendKey: ReturnType<typeof vi.fn>
    }
  >,
  workers: [] as Array<
    EventTarget & {
      sent: Array<{
        message: { id: number; title: string; url: string; image?: string; bitmap?: ImageBitmap }
        transfer: Transferable[]
      }>
      postMessage: ReturnType<typeof vi.fn>
      terminate: ReturnType<typeof vi.fn>
    }
  >,
}))
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    viewOnly = false
    resizeSession = true
    focusOnClick = true
    disconnect = vi.fn()
    sendKey = vi.fn()
    constructor(target: HTMLElement) {
      super()
      const canvas = document.createElement("canvas")
      canvas.width = 1280
      canvas.height = 800
      target.append(canvas)
      mock.viewers.push(this)
    }
  },
}))

const installPreviewWorker = (respond = true) => {
  class PreviewWorker extends EventTarget {
    sent: Array<{
      message: { id: number; title: string; url: string; image?: string; bitmap?: ImageBitmap }
      transfer: Transferable[]
    }> = []
    postMessage = vi.fn((message: PreviewWorker["sent"][number]["message"], transfer: Transferable[] = []) => {
      this.sent.push({ message, transfer })
      if (message.bitmap) message.bitmap.close()
      if (!respond) return
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { id: message.id, title: message.title, url: message.url, src: "data:image/jpeg;base64,cHJvY2Vzc2Vk" },
        }),
      )
    })
    terminate = vi.fn()

    constructor() {
      super()
      mock.workers.push(this)
    }
  }
  vi.stubGlobal("Worker", PreviewWorker)
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mock.viewers.splice(0)
  mock.workers.splice(0)
})

test("VM pipeline is always view-only, samples at 1 fps and releases its session", async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    "WebSocket",
    class {
      close = vi.fn()
    },
  )
  installPreviewWorker()
  const bitmap = { width: 1280, height: 800, close: vi.fn() } as ImageBitmap
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  )
  const request = vi.fn(async (route: string) =>
    route === "POST /bots/:id/desktop"
      ? { sessionId: "preview", path: "/api/v1/desktop/preview/socket", control: false }
      : { tabs: [{ title: "Página atual", url: "https://example.org", state: "live", lastUsedAt: 1 }] },
  )
  const unsubscribe = vi.fn()
  const api = {
    request,
    subscribe: () => unsubscribe,
    websocketUrl: (path: string) => `ws://localhost${path}`,
    isMock: false,
  } as UiApi
  const frame = vi.fn()
  const stop = startInlineFrameSource(api, { id: "bot", machine: "vm" } as Bot, undefined, frame, vi.fn())
  await vi.waitFor(() => expect(mock.viewers).toHaveLength(1))
  const viewer = mock.viewers[0]
  expect(request).toHaveBeenCalledWith("POST /bots/:id/desktop", { control: false, preview: true }, { id: "bot" })
  expect(viewer?.viewOnly).toBe(true)
  expect(viewer?.resizeSession).toBe(false)
  expect(viewer?.focusOnClick).toBe(false)
  viewer?.dispatchEvent(new Event("connect"))
  await vi.advanceTimersByTimeAsync(0)
  expect(frame).toHaveBeenCalledTimes(1)
  expect(mock.workers[0]?.sent[0]?.transfer).toEqual([bitmap])
  await vi.advanceTimersByTimeAsync(999)
  expect(frame).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(frame).toHaveBeenCalledTimes(2)
  expect(viewer?.sendKey).not.toHaveBeenCalled()
  stop()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(frame).toHaveBeenCalledTimes(2)
  expect(viewer?.disconnect).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledWith("DELETE /desktop/:id", {}, { id: "preview" })
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("a session that resolves after stopping is immediately released", async () => {
  let resolve: (session: unknown) => void = () => {}
  installPreviewWorker()
  const request = vi.fn((route: string) =>
    route === "POST /bots/:id/desktop"
      ? new Promise((done) => {
          resolve = done
        })
      : Promise.resolve({ tabs: [] }),
  )
  const api = { request, subscribe: () => () => {}, websocketUrl: () => "ws://localhost", isMock: false } as UiApi
  const frame = vi.fn()
  const stop = startInlineFrameSource(api, { id: "bot", machine: "vm" } as Bot, undefined, frame, vi.fn())
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /bots/:id/desktop", { control: false, preview: true }, { id: "bot" }),
  )
  stop()
  resolve({ sessionId: "late", path: "/socket", control: false })
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("DELETE /desktop/:id", {}, { id: "late" }))
  expect(mock.viewers).toHaveLength(0)
  expect(frame).not.toHaveBeenCalled()
})

test("host browser polling sends images to the worker and stays serial", async () => {
  vi.useFakeTimers()
  installPreviewWorker()
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const request = vi.fn(async (route: string) =>
    route === "GET /browser/tabs"
      ? { tabs: [] }
      : { title: "Página", url: "https://example.org", image: "data:image/jpeg;base64,aGVsbG8=" },
  )
  const api = { request, subscribe: () => () => {}, isMock: false } as UiApi
  const frame = vi.fn()
  const stop = startInlineFrameSource(api, { id: "host", machine: "local" } as Bot, "tab", frame, vi.fn())
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledWith(
    "GET /bots/:id/browser-preview",
    { tabId: "tab" },
    { id: "host" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(mock.workers[0]?.sent[0]?.message.image).toBe("data:image/jpeg;base64,aGVsbG8=")
  expect(frame).toHaveBeenCalledTimes(1)
  // connect-src refuses fetch(data:) in the app; frames are decoded and emitted as data: images.
  expect(fetch).not.toHaveBeenCalled()
  expect(frame).toHaveBeenCalledWith({
    src: "data:image/jpeg;base64,cHJvY2Vzc2Vk",
    title: "Página",
    url: "https://example.org",
  })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(frame).toHaveBeenCalledTimes(2)
  stop()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(frame).toHaveBeenCalledTimes(2)
  expect(request).not.toHaveBeenCalledWith("POST /bots/:id/desktop", expect.anything(), expect.anything())
})

test("browser thumbnails are resized in a worker and use the CSP-safe JPEG source", async () => {
  const workers: Array<{
    dispatchEvent: EventTarget["dispatchEvent"]
    postMessage: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
  }> = []
  class MockPreviewWorker extends EventTarget {
    postMessage = vi.fn((_message: unknown, _transfer?: Transferable[]) => {})
    terminate = vi.fn()
    constructor() {
      super()
      workers.push(this)
    }
  }
  vi.stubGlobal("Worker", MockPreviewWorker)
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA")
  const request = vi.fn(async (route: string) =>
    route === "GET /bots/:id/browser-preview"
      ? { title: "Página", url: "https://example.org", image: "data:image/jpeg;base64,c21hbGw=" }
      : { tabs: [] },
  )
  const api = { request, subscribe: () => () => {}, isMock: false } as UiApi
  const frame = vi.fn()

  const stop = startInlineFrameSource(api, { id: "bot", machine: "local" } as Bot, "tab", frame, vi.fn())
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/browser-preview",
      { tabId: "tab" },
      { id: "bot" },
      { signal: expect.any(AbortSignal) },
    ),
  )

  const worker = workers[0]
  if (!worker) throw new Error("The browser thumbnail worker did not start")
  const message = worker.postMessage.mock.calls[0]?.[0] as { id: number }
  worker.dispatchEvent(
    new MessageEvent("message", {
      data: {
        id: message.id,
        title: "Página",
        url: "https://example.org",
        src: "data:image/jpeg;base64,SlBFRw==",
      },
    }),
  )
  await vi.waitFor(() =>
    expect(frame).toHaveBeenCalledWith({
      src: "data:image/jpeg;base64,SlBFRw==",
      title: "Página",
      url: "https://example.org",
    }),
  )

  expect(toDataURL).not.toHaveBeenCalled()

  stop()

  expect(worker.terminate).toHaveBeenCalledOnce()
})

test("a local preview fails closed when the worker is unavailable for an oversized image", async () => {
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("Worker could not start")
      }
    },
  )
  const image = `data:image/png;base64,${"A".repeat(24_000_001)}`
  const request = vi.fn(async (route: string) =>
    route === "GET /bots/:id/browser-preview"
      ? { image, title: "Synthetic page", url: "https://example.test" }
      : { tabs: [] },
  )
  const api = {
    request,
    subscribe: () => () => {},
    isMock: false,
  } as UiApi
  const frame = vi.fn()
  const unavailable = vi.fn()

  const stop = startInlineFrameSource(api, { id: "bot", machine: "local" } as Bot, undefined, frame, unavailable)

  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce())
  expect(frame).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalledWith("GET /bots/:id/browser-preview", expect.anything(), expect.anything())
  stop()
})

test("a VM session request that never answers reports the cause after 20 s", async () => {
  vi.useFakeTimers()
  installPreviewWorker()
  const api = {
    request: vi.fn((route: string) =>
      route === "POST /bots/:id/desktop" ? new Promise(() => {}) : Promise.resolve({ tabs: [] }),
    ),
    subscribe: () => () => {},
    websocketUrl: (path: string) => `ws://localhost${path}`,
    isMock: false,
  } as unknown as UiApi
  const unavailable = vi.fn()
  const stop = startInlineFrameSource(api, { id: "bot", machine: "vm" } as Bot, undefined, vi.fn(), unavailable)
  await vi.advanceTimersByTimeAsync(20_500)
  expect(unavailable).toHaveBeenCalledWith(expect.stringContaining("A VM não respondeu ao pedido da prévia em 20 s"))
  stop()
})

test("a local preview that keeps failing exposes the real reason while it keeps polling", async () => {
  vi.useFakeTimers()
  installPreviewWorker()
  const api = {
    request: vi.fn((route: string) =>
      route === "GET /bots/:id/browser-preview"
        ? Promise.reject(new Error("Nenhuma página disponível para prévia"))
        : Promise.resolve({ tabs: [] }),
    ),
    subscribe: () => () => {},
    isMock: false,
  } as unknown as UiApi
  const status = vi.fn()
  const stop = startInlineFrameSource(api, { id: "bot", machine: "local" } as Bot, undefined, vi.fn(), vi.fn(), status)
  await vi.advanceTimersByTimeAsync(2_500)
  expect(status).toHaveBeenCalledWith("Nenhuma página disponível para prévia")
  expect(api.request).toHaveBeenCalledWith(
    "GET /bots/:id/browser-preview",
    {},
    { id: "bot" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  stop()
})

test("data: frames are decoded locally instead of through fetch, which the desktop CSP refuses", async () => {
  const { dataUrlBlob } = await import("../src/features/desktop/inlineFrameSource")
  const blob = dataUrlBlob("data:image/png;base64,aGVsbG8=")
  expect(blob.type).toBe("image/png")
  expect(blob.size).toBe(5)
  expect(() => dataUrlBlob("blob:https://tauri.localhost/1")).toThrow()
})

test("a VM browser card samples its authorized tab instead of the complete computer screen", async () => {
  installPreviewWorker()
  const request = vi.fn(async (route: string) =>
    route === "GET /browser/tabs"
      ? { tabs: [] }
      : { image: "data:image/jpeg;base64,ZmFrZQ==", title: "Synthetic", url: "https://example.test" },
  )
  const api = { request, subscribe: () => () => {}, isMock: false } as UiApi
  const frame = vi.fn()

  const stop = startInlineFrameSource(api, { id: "leo", machine: "vm" }, "tab", frame, vi.fn())
  await vi.waitFor(() => expect(frame).toHaveBeenCalledOnce())
  stop()

  expect(request).toHaveBeenCalledWith(
    "GET /bots/:id/browser-preview",
    { tabId: "tab" },
    { id: "leo" },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(request).not.toHaveBeenCalledWith("POST /bots/:id/desktop", expect.anything(), expect.anything())
})

test("a worker frame from before takeover cannot return after public preview is purged", async () => {
  installPreviewWorker(false)
  let listener: (envelope: UiEventEnvelope) => void = () => {}
  const api = {
    request: vi.fn(async (route: string) =>
      route === "GET /browser/tabs"
        ? { tabs: [] }
        : { image: "data:image/jpeg;base64,ZmFrZQ==", title: "Synthetic", url: "https://example.test" },
    ),
    subscribe: (next: typeof listener) => {
      listener = next
      return () => {}
    },
    isMock: false,
  } as UiApi
  const frame = vi.fn()
  const reset = vi.fn()
  const stop = startInlineFrameSource(api, { id: "leo", machine: "local" }, "tab", frame, vi.fn(), undefined, {
    onReset: reset,
  })
  await vi.waitFor(() => expect(mock.workers[0]?.sent).toHaveLength(1))
  const worker = mock.workers[0]
  if (!worker) throw new Error("Missing preview processor")

  listener({
    seq: 1,
    at: 1,
    event: {
      type: "browser.tab",
      tab: {
        tabId: "tab",
        ownerBotId: "leo",
        title: "",
        url: "",
        state: "live",
        openerTabId: null,
        heldByUser: true,
        lastUsedAt: 1,
      },
    },
  })
  worker.dispatchEvent(
    new MessageEvent("message", {
      data: {
        id: worker.sent[0]?.message.id,
        title: "Private",
        url: "https://example.test/private",
        src: "data:image/jpeg;base64,ZmFrZQ==",
      },
    }),
  )
  await Promise.resolve()
  await Promise.resolve()
  stop()

  expect(reset).toHaveBeenCalledOnce()
  expect(frame).not.toHaveBeenCalled()
})
