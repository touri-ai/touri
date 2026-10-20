import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { PreviewScreen } from "../src/components/WorkspaceScreens"
import { computerKillSwitchEvent, installComputerKillSwitch } from "../src/computerKillSwitch"
import { DesktopPanel } from "../src/features/desktop/DesktopPanel"
import { createDesktopKeyboard } from "../src/features/desktop/keyboard"

const { viewers } = vi.hoisted(() => ({
  viewers: [] as Array<
    EventTarget & {
      viewOnly: boolean
      disconnect: () => void
      sendKey: ReturnType<typeof vi.fn>
      getImageData: () => ImageData
    }
  >,
}))
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    viewOnly = false
    disconnect = vi.fn()
    blur = vi.fn()
    sendKey = vi.fn()
    getImageData = () => pulse(1)
    constructor() {
      super()
      viewers.push(this)
    }
  },
}))

const pulse = (sequence: number): ImageData => {
  const data = new Uint8ClampedArray(8 * 8 * 4)
  data.set([sequence, 0x30, 0x40, 255], (4 * 8 + 4) * 4)
  return { data, width: 8, height: 8, colorSpace: "srgb" }
}
const bot = { id: "vm", name: "Tela", machine: "vm", computerUse: true, browserEnabled: true } as Bot
const fixture = () => {
  const request = vi.fn(async (route: string, body: { control?: boolean }) =>
    route === "POST /bots/:id/desktop"
      ? { sessionId: "session", path: "/api/v1/desktop/session/socket", control: body.control ?? false }
      : {},
  )
  class Socket extends EventTarget {
    close = vi.fn()
    constructor(public url: string) {
      super()
      sockets.push(this)
    }
  }
  const sockets: Socket[] = []
  vi.stubGlobal("WebSocket", Socket)
  return {
    request,
    sockets,
    api: {
      request,
      subscribe: () => () => {},
      isMock: false,
      websocketUrl: (path: string) => `ws://localhost${path}`,
    } as UiApi,
  }
}
afterEach(() => {
  cleanup()
  viewers.splice(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const connected = async () => {
  await waitFor(() => expect(viewers.length).toBeGreaterThan(0))
  await act(async () => viewers.at(-1)?.dispatchEvent(new Event("connect")))
}

test("manual takeover does not require or change bot automation permission; only explicit return resumes it", async () => {
  const f = fixture()
  render(<DesktopPanel bot={{ ...bot, computerUse: false }} api={f.api} />)
  await connected()
  expect(screen.getByText("Acompanhar a tela")).toHaveClass("desktop-mode")
  expect(viewers[0]?.viewOnly).toBe(true)
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  expect(f.request).toHaveBeenCalledWith("POST /bots/:id/desktop", { control: true, resume: true }, { id: "vm" })
  expect(screen.getByText("Você está no controle. O bot aguarda você terminar.")).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Devolver ao bot" }))
  await waitFor(() => expect(f.request).toHaveBeenCalledWith("POST /bots/:id/desktop/return", {}, { id: "vm" }))
  await waitFor(() => expect(viewers).toHaveLength(3))
  await connected()
  expect(viewers.at(-1)?.viewOnly).toBe(true)
  expect(f.request.mock.calls.some(([route]) => route.startsWith("PATCH"))).toBe(false)
})

test("a remote runtime without a pause protocol stays in observation with no dead control button", async () => {
  const f = fixture()
  render(<DesktopPanel bot={{ ...bot, machine: "cloud", computerUse: false, browserEnabled: false }} api={f.api} />)
  await connected()
  expect(screen.queryByRole("button", { name: "Assumir controle" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Devolver ao bot" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Ativar navegador" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Configurar controle" })).toBeNull()
  expect(
    screen.getByText(
      "O controle manual não está disponível nesta máquina. Você pode acompanhar a tela e conversar com o bot.",
    ),
  ).toBeInTheDocument()
  expect(viewers[0]?.viewOnly).toBe(true)
  expect(f.request).toHaveBeenCalledWith("POST /bots/:id/desktop", { control: false }, { id: "vm" })
})

test("a late observation snapshot cannot erase a newer human ownership event", async () => {
  const f = fixture()
  let notify = () => {}
  f.api.subscribe = (listener) => {
    notify = () => listener({ seq: 1, at: 1, event: { type: "desktop.control", botId: bot.id, human: true } })
    return () => {}
  }
  let finish: ((session: { sessionId: string; path: string; control: boolean }) => void) | undefined
  f.request.mockImplementation(async (route) =>
    route === "POST /bots/:id/desktop"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : {},
  )
  render(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(finish).toBeDefined())
  act(() => notify())
  await act(async () => finish?.({ sessionId: "observe", path: "/api/v1/desktop/observe/socket", control: false }))
  await connected()
  expect(screen.getByRole("button", { name: "Devolver ao bot" })).toBeEnabled()
  expect(
    screen.getByText("O bot está aguardando. Assuma o controle para usar o teclado e o mouse."),
  ).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
})

test("a connected socket stays in preparation until the first guest frame is rendered", async () => {
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(viewers).toHaveLength(1))
  const black = pulse(0)
  black.data.fill(0)
  const viewer = viewers[0]
  if (!viewer) throw new Error("Missing viewer")
  viewer.getImageData = () => black
  await connected()
  expect(screen.getByText("Conectando…")).toBeInTheDocument()
  expect(screen.getByText("Sem imagem ainda. Aguardando a primeira imagem da VM.")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeDisabled()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  // An opaque black frame is guest output too; readiness cannot require colored pixels.
  for (let offset = 3; offset < black.data.length; offset += 4) black.data[offset] = 255
  await waitFor(() => expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled(), {
    timeout: 10_000,
  })
  expect(screen.queryByText("Conectando à tela da VM…")).not.toBeInTheDocument()
  expect(screen.getByText("Navegador ainda não aberto")).toBeInTheDocument()
})

test("the empty VM hint disappears when a window draws and returns when the display is cleared", async () => {
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  expect(screen.getByText("Navegador ainda não aberto")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled()
  const viewer = viewers[0]
  if (!viewer) throw new Error("Missing viewer")
  const window = pulse(2)
  window.data.set([100, 120, 140, 255], 0)
  viewer.getImageData = () => window
  await waitFor(() => expect(screen.queryByText("Navegador ainda não aberto")).not.toBeInTheDocument(), {
    timeout: 2500,
  })
  viewer.getImageData = () => pulse(3)
  await waitFor(() => expect(screen.getByText("Navegador ainda não aberto")).toBeInTheDocument(), { timeout: 10_000 })
  expect(viewer.disconnect).not.toHaveBeenCalled()
})

test("an empty VM screen shows the real cause of the last failed browser tool", async () => {
  const f = fixture()
  const cause = "O navegador da VM não respondeu no prazo. Tente novamente para reconectar o navegador."
  f.request.mockImplementation(async (route: string, body: { control?: boolean }) => {
    if (route === "POST /bots/:id/desktop")
      return { sessionId: "session", path: "/api/v1/desktop/session/socket", control: body.control ?? false }
    if (route === "GET /browser/tabs")
      return { tabs: [], lastFailure: { tool: "browser_open", errorCode: "DEADLINE_EXCEEDED", error: cause, at: 1 } }
    return {}
  })
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  await waitFor(() => expect(screen.getByText("O navegador não abriu a página")).toBeInTheDocument())
  expect(screen.getByText(cause)).toBeInTheDocument()
  expect(f.request).toHaveBeenCalledWith("GET /browser/tabs", { botId: "vm" })
})

test("Preview contains project tabs only, even for a VM bot", async () => {
  const f = fixture()
  const props = {
    project: null,
    processes: [],
    preview: null,
    browserTabs: [],
    selectedBot: bot,
    selectedThread: null,
    selectedMessages: [],
    api: f.api,
    invokeCommand: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRestart: vi.fn(),
    onSend: vi.fn(),
    onBack: vi.fn(),
    onConnectProject: vi.fn(),
    onNotice: vi.fn(),
  }
  const view = render(<PreviewScreen {...props} />)
  expect(screen.queryByRole("tab", { name: "Tela da VM" })).not.toBeInTheDocument()
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Preview", "Logs", "Navegador"])
  expect(viewers).toHaveLength(0)
  view.rerender(<PreviewScreen {...props} selectedBot={{ ...bot, id: "local", machine: "local" }} />)
  expect(screen.queryByRole("tab", { name: "Tela da VM" })).not.toBeInTheDocument()
})

test("the emergency chord is captured in the VM textarea and cannot reach the guest", async () => {
  const f = fixture()
  const uninstall = installComputerKillSwitch(f.api)
  try {
    render(<DesktopPanel bot={bot} api={f.api} />)
    await connected()
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
    await waitFor(() => expect(viewers).toHaveLength(2))
    await connected()
    const controller = viewers[1]
    const input = screen.getByLabelText("Digitar na VM")
    fireEvent.keyDown(input, { key: "Control", code: "ControlLeft", ctrlKey: true })
    // Option can change event.key on macOS; recognize the physical Period key.
    fireEvent.keyDown(input, { key: "≥", code: "Period", ctrlKey: true, altKey: true, metaKey: true })
    expect(controller?.viewOnly).toBe(true)
    expect(controller?.disconnect).toHaveBeenCalled()
    expect(controller?.sendKey).toHaveBeenLastCalledWith(0xffe3, null, false)
    expect(f.request).toHaveBeenCalledWith("POST /computer/kill", {})
    expect(input).toBeDisabled()
    await waitFor(() => expect(viewers).toHaveLength(3))
    await connected()
    expect(screen.getByRole("button", { name: "Assumir controle" })).toHaveAttribute("aria-pressed", "false")
    expect(input).toBeDisabled()
  } finally {
    uninstall()
  }
})

test("pressing on the screen under control focuses the VM keyboard before noVNC captures the pointer", async () => {
  const f = fixture()
  const view = render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  const input = screen.getByLabelText("Digitar na VM")
  await waitFor(() => expect(input).toBeEnabled())
  const display = view.container.querySelector(".desktop-canvas")
  if (!display) throw new Error("Missing display")
  // noVNC stops mousedown and its capture overlay retargets the click to <body>.
  const swallow = (event: Event) => event.stopPropagation()
  display.addEventListener("mousedown", swallow)
  fireEvent.mouseDown(display)
  expect(document.activeElement).toBe(input)
  fireEvent.input(input, { target: { value: "ok" } })
  expect(viewers[1]?.sendKey).toHaveBeenCalledWith("o".codePointAt(0), null, undefined)
  expect(viewers[1]?.sendKey).toHaveBeenCalledWith("k".codePointAt(0), null, undefined)
})

test("an occluded window (document hidden) still shows its first image", async () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: true })
  try {
    const f = fixture()
    render(<DesktopPanel bot={bot} api={f.api} />)
    await connected()
    await waitFor(() => expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled())
    expect(screen.queryByText("Sem imagem ainda. Aguardando a primeira imagem da VM.")).toBeNull()
  } finally {
    Object.defineProperty(document, "hidden", { configurable: true, value: false })
  }
})

test("a kill event during connection refuses a late control response", async () => {
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  let finish: ((session: { sessionId: string; path: string; control: boolean }) => void) | undefined
  const request = f.request.getMockImplementation()
  f.request.mockImplementation(async (route, body) =>
    route === "POST /bots/:id/desktop" && body.control
      ? new Promise((resolve) => {
          finish = resolve
        })
      : (request ?? (async () => ({})))(route, body),
  )
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(finish).toBeDefined())
  act(() => window.dispatchEvent(new Event(computerKillSwitchEvent)))
  await act(async () =>
    finish?.({ sessionId: "late-control", path: "/api/v1/desktop/late-control/socket", control: true }),
  )
  await waitFor(() => expect(f.request).toHaveBeenCalledWith("DELETE /desktop/:id", {}, { id: "late-control" }))
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  expect(viewers.every((viewer) => viewer.viewOnly)).toBe(true)
})

test("disconnect surfaces a tripwire and reconnect always requests observation", async () => {
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  act(() => viewers.at(-1)?.dispatchEvent(new Event("disconnect")))
  expect(screen.getByText("Não foi possível receber a imagem")).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  fireEvent.click(screen.getAllByRole("button", { name: "Reconectar tela" })[0])
  await waitFor(() =>
    expect(f.request).toHaveBeenLastCalledWith(
      "POST /bots/:id/desktop",
      { control: false, resume: true },
      { id: "vm" },
    ),
  )
})

test("a lost VNC socket logs its close code and retries the running session with backoff", async () => {
  const f = fixture()
  const log = vi.spyOn(console, "warn").mockImplementation(() => {})
  const view = render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  vi.useFakeTimers()
  act(() =>
    f.sockets
      .find((socket) => socket.url.includes("/desktop/"))
      ?.dispatchEvent(new CloseEvent("close", { code: 1006 })),
  )
  expect(log).toHaveBeenCalledWith("Conexão da tela encerrada", { botId: "vm", code: 1006 })
  await act(async () => vi.advanceTimersByTimeAsync(999))
  expect(viewers).toHaveLength(1)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(viewers).toHaveLength(2)
  expect(f.request).toHaveBeenLastCalledWith("POST /bots/:id/desktop", { control: false, resume: true }, { id: "vm" })
  act(() => viewers.at(-1)?.dispatchEvent(new Event("disconnect")))
  await act(async () => vi.advanceTimersByTimeAsync(1_999))
  expect(viewers).toHaveLength(2)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(viewers).toHaveLength(3)
  act(() => viewers.at(-1)?.dispatchEvent(new Event("disconnect")))
  view.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(viewers).toHaveLength(3)
})

test("Unicode paste commits IME once and keeps subsequent text in order", async () => {
  const sendKey = vi.fn()
  let finish: () => void = () => {}
  const pasteText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const keyboard = createDesktopKeyboard({ sendKey, pasteText }, false)
  keyboard.compositionstart()
  keyboard.compositionend("Olá 日本😀")
  keyboard.input("Olá 日本😀", false)
  keyboard.input("!", false)
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Enter", code: "Enter" }))
  keyboard.keyup(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }))
  await Promise.resolve()
  expect(pasteText).toHaveBeenCalledExactlyOnceWith("Olá 日本😀")
  expect(sendKey).not.toHaveBeenCalled()
  finish()
  await waitFor(() =>
    expect(sendKey.mock.calls).toEqual([
      [33, null],
      [0xff0d, null, true],
      [0xff0d, null, false],
    ]),
  )
})

test("a late paste failure from the old session cannot close a reconnected viewer", async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()
  if (!original) throw new Error("Missing request implementation")
  let rejectPaste: (reason: Error) => void = () => {}
  f.request.mockImplementation((route, body) =>
    route === "POST /desktop/:id/text"
      ? new Promise((_resolve, reject) => {
          rejectPaste = reject
        })
      : original(route, body),
  )
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  fireEvent.input(screen.getByLabelText("Digitar na VM"), { target: { value: "日本" } })
  await act(async () => {
    await Promise.resolve()
  })
  vi.useFakeTimers()
  act(() => viewers.at(-1)?.dispatchEvent(new Event("disconnect")))
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(viewers).toHaveLength(3)
  await act(async () => viewers.at(-1)?.dispatchEvent(new Event("connect")))
  await act(async () => {
    rejectPaste(new Error("Old session closed"))
    await Promise.resolve()
  })
  expect(viewers.at(-1)?.disconnect).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled()
})

test("rendered heartbeat stalling shows reconnection even while the RFB socket stays open", async () => {
  const f = fixture()
  let now = 0
  let tick: (() => void) | undefined
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const interval = globalThis.setInterval
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
    if (delay === 1_000) tick = callback as () => void
    return interval(callback, delay)
  })
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  act(() => {
    for (now = 1000; now <= 10_000; now += 1000) {
      tick?.()
    }
  })
  expect(screen.getByText("Não foi possível receber a imagem")).toBeInTheDocument()
})

test("unmount releases one-use session and disconnects the viewer", async () => {
  const f = fixture()
  const view = render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  view.unmount()
  expect(f.request).toHaveBeenCalledWith("DELETE /desktop/:id", {}, { id: "session" })
  expect(viewers[0]?.disconnect).toHaveBeenCalled()
})

test("a late startup response after unmount releases its session without opening a viewer", async () => {
  const f = fixture()
  let finish: ((session: { sessionId: string; path: string; control: boolean }) => void) | undefined
  f.request.mockImplementation(async (route) =>
    route === "POST /bots/:id/desktop"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : {},
  )
  const view = render(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(finish).toBeDefined())
  view.unmount()
  await act(async () => finish?.({ sessionId: "late", path: "/api/v1/desktop/late/socket", control: false }))
  expect(viewers).toHaveLength(0)
  expect(f.request).toHaveBeenCalledWith("DELETE /desktop/:id", {}, { id: "late" })
})

test("pausing for a modal disconnects control and resumes in observation", async () => {
  const f = fixture()
  const view = render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  view.rerender(<DesktopPanel bot={bot} api={f.api} paused />)
  expect(viewers[1]?.disconnect).toHaveBeenCalled()
  expect(screen.getByText("Tela pausada")).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  view.rerender(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(viewers).toHaveLength(3))
  expect(f.request).toHaveBeenLastCalledWith("POST /bots/:id/desktop", { control: false, resume: true }, { id: "vm" })
})

test("a static black desktop stays ready for 30 seconds without closing or creating another session", async () => {
  const f = fixture()
  let now = 0
  let tick: (() => void) | undefined
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const interval = globalThis.setInterval
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
    if (delay === 1_000) tick = callback as () => void
    return interval(callback, delay)
  })
  render(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(viewers).toHaveLength(1))
  const viewer = viewers[0]
  if (!viewer) throw new Error("Missing viewer")
  const image = pulse(0)
  image.data.fill(0)
  for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255
  viewer.getImageData = () => image
  await connected()
  const canvas = document.createElement("canvas")
  document.querySelector(".desktop-canvas")?.append(canvas)
  fireEvent.mouseDown(canvas)
  fireEvent.input(screen.getByLabelText("Digitar na VM"), { target: { value: "ignored" } })
  act(() => {
    for (now = 1_000; now <= 30_000; now += 1_000) tick?.()
  })
  expect(screen.getByRole("button", { name: "Assumir controle" })).toBeEnabled()
  expect(screen.queryByText("Conectando…")).not.toBeInTheDocument()
  expect(screen.queryByText("Não foi possível receber a imagem")).not.toBeInTheDocument()
  expect(viewer.disconnect).not.toHaveBeenCalled()
  expect(f.request.mock.calls.filter(([route]) => route === "POST /bots/:id/desktop")).toHaveLength(1)
  expect(f.request.mock.calls.filter(([route]) => route === "DELETE /desktop/:id")).toHaveLength(0)
})

test.each(["keyboard", "mouse"])("%s input followed by no draw trips a display without a heartbeat", async (source) => {
  const f = fixture()
  let now = 0
  let tick: (() => void) | undefined
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const interval = globalThis.setInterval
  vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
    if (delay === 1_000) tick = callback as () => void
    return interval(callback, delay)
  })
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  const viewer = viewers[1]
  if (!viewer) throw new Error("Missing viewer")
  const image = pulse(0)
  image.data.fill(0)
  for (let offset = 3; offset < image.data.length; offset += 4) image.data[offset] = 255
  viewer.getImageData = () => image
  await connected()
  if (source === "keyboard") {
    fireEvent.input(screen.getByLabelText("Digitar na VM"), { target: { value: "hello" } })
    expect(viewer.sendKey).toHaveBeenCalled()
  } else {
    const canvas = document.createElement("canvas")
    document.querySelector(".desktop-canvas")?.append(canvas)
    fireEvent.mouseDown(canvas)
  }
  act(() => {
    now = 8_000
    tick?.()
  })
  expect(screen.getByText("Não foi possível receber a imagem")).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  expect(viewer.disconnect).toHaveBeenCalled()
})

test("IME commits Unicode once, ignores composing key events, and allows mac Option text", () => {
  const sendKey = vi.fn()
  const keyboard = createDesktopKeyboard({ sendKey }, true)
  keyboard.compositionstart()
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }))
  expect(keyboard.input("に", true)).toBe(false)
  expect(sendKey).not.toHaveBeenCalled()
  keyboard.compositionend("日本😀")
  keyboard.input("日本😀", false)
  expect(sendKey.mock.calls).toEqual([
    [0x01000000 + 0x65e5, null],
    [0x01000000 + 0x672c, null],
    [0x01000000 + 0x1f600, null],
  ])
  sendKey.mockClear()
  keyboard.keydown(new KeyboardEvent("keydown", { key: "é", altKey: true }))
  keyboard.input("é", false)
  expect(sendKey.mock.calls).toEqual([[0xe9, null]])
})

test("text input maps Latin-1 directly and non-Latin-1 Unicode to X11 keysyms", () => {
  const sendKey = vi.fn()
  const keyboard = createDesktopKeyboard({ sendKey }, false)
  keyboard.input("Olá 日本😀", false)
  expect(sendKey.mock.calls).toEqual([
    [0x4f, null],
    [0x6c, null],
    [0xe1, null],
    [0x20, null],
    [0x010065e5, null],
    [0x0100672c, null],
    [0x0101f600, null],
  ])
})

test("mac Command maps to Ctrl and releases omitted shortcut keyups on blur", () => {
  const sendKey = vi.fn()
  const keyboard = createDesktopKeyboard({ sendKey }, true)
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Meta", code: "MetaLeft" }))
  keyboard.keydown(new KeyboardEvent("keydown", { key: "a", code: "KeyA", metaKey: true }))
  keyboard.keyup(new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft" }))
  expect(sendKey.mock.calls).toEqual([
    [0xffe3, null, true],
    [97, null, true],
    [0xffe3, null, false],
    [97, null, false],
  ])
  sendKey.mockClear()
  keyboard.keydown(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft" }))
  keyboard.release()
  expect(sendKey.mock.calls).toEqual([
    [0xff51, null, true],
    [0xff51, null, false],
  ])
})

test("blur discards unfinished IME text, and dead-key text is sent after composition", () => {
  const sendKey = vi.fn()
  const keyboard = createDesktopKeyboard({ sendKey }, true)
  keyboard.compositionstart()
  keyboard.reset()
  keyboard.compositionend("未")
  expect(sendKey).not.toHaveBeenCalled()
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Dead", altKey: true }))
  keyboard.input("é", false)
  expect(sendKey.mock.calls).toEqual([[0xe9, null]])
})

test("releasing mac Command preserves physical Shift and Ctrl and releases omitted letter keyups", () => {
  const sendKey = vi.fn()
  const keyboard = createDesktopKeyboard({ sendKey }, true)
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Control", code: "ControlLeft" }))
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", ctrlKey: true }))
  keyboard.keydown(new KeyboardEvent("keydown", { key: "Meta", code: "MetaLeft", ctrlKey: true, shiftKey: true }))
  keyboard.keydown(
    new KeyboardEvent("keydown", { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true, metaKey: true }),
  )
  keyboard.keyup(new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft", ctrlKey: true, shiftKey: true }))
  expect(sendKey.mock.calls).toEqual([
    [0xffe3, null, true],
    [0xffe1, null, true],
    [65, null, true],
    [65, null, false],
  ])
  keyboard.keyup(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", ctrlKey: true }))
  keyboard.keyup(new KeyboardEvent("keyup", { key: "Control", code: "ControlLeft" }))
  expect(sendKey.mock.calls.slice(-2)).toEqual([
    [0xffe1, null, false],
    [0xffe3, null, false],
  ])
})

test("a viewer that never completes the handshake shows a real cause instead of waiting forever", async () => {
  vi.useFakeTimers()
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await act(async () => vi.advanceTimersByTimeAsync(10))
  expect(viewers).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_100)
  })
  expect(screen.getByText(/A tela da VM não respondeu em 15 s/)).toBeInTheDocument()
})

test("a connected viewer that never receives an image shows a real cause", async () => {
  vi.useFakeTimers()
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await act(async () => vi.advanceTimersByTimeAsync(10))
  const viewer = viewers[0]
  if (!viewer) throw new Error("Missing viewer")
  viewer.getImageData = () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0, colorSpace: "srgb" })
  await act(async () => viewer.dispatchEvent(new Event("connect")))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_500)
  })
  expect(screen.getByText(/conectou, mas não enviou nenhuma imagem/)).toBeInTheDocument()
})

test("a desktop session request that never answers ends with a real pt-BR cause instead of waiting forever", async () => {
  vi.useFakeTimers()
  const request = vi.fn(() => new Promise(() => {}))
  const api = {
    request,
    subscribe: () => () => {},
    isMock: false,
    websocketUrl: (path: string) => `ws://localhost${path}`,
  } as unknown as UiApi
  render(<DesktopPanel bot={bot} api={api} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByText("Pedindo a sessão da tela à VM…")).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_500)
  })
  expect(screen.getByText(/A VM não respondeu ao pedido da tela em 30 s/)).toBeInTheDocument()
  expect(screen.getByText("Não foi possível receber a imagem")).toBeInTheDocument()
})

test("a socket that connects but never delivers a frame reports the handshake timeout", async () => {
  vi.useFakeTimers()
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(viewers.length).toBeGreaterThan(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_500)
  })
  expect(screen.getByText(/A tela da VM não respondeu em 15 s/)).toBeInTheDocument()
})

test("screen loss keeps human ownership until explicit return and Stop cancels only this bot's task", async () => {
  const f = fixture()
  const original = f.request.getMockImplementation()
  if (!original) throw new Error("Missing request")
  f.request.mockImplementation(async (route, body) =>
    route === "GET /workspace/activity"
      ? {
          runs: [
            { id: "pending", botId: bot.id, status: "running" },
            { id: "other", botId: "other", status: "running" },
            { id: "done", botId: bot.id, status: "succeeded" },
          ],
        }
      : original(route, body),
  )
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await waitFor(() => expect(viewers).toHaveLength(2))
  await connected()
  act(() => viewers.at(-1)?.dispatchEvent(new Event("disconnect")))
  expect(screen.getByText("A conexão com a tela caiu. A tarefa pode continuar em execução.")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Devolver ao bot" })).toBeEnabled()
  expect(f.request.mock.calls.some(([route]) => route === "POST /bots/:id/desktop/return")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "Parar tarefa" }))
  await waitFor(() => expect(f.request).toHaveBeenCalledWith("POST /runs/:id/cancel", {}, { id: "pending" }))
  expect(f.request).not.toHaveBeenCalledWith("POST /runs/:id/cancel", {}, { id: "other" })
  expect(f.request).not.toHaveBeenCalledWith("POST /runs/:id/cancel", {}, { id: "done" })
})

test("human ownership without a frame announces waiting, never usable control", async () => {
  const f = fixture()
  f.request.mockImplementation(async (route) =>
    route === "POST /bots/:id/desktop"
      ? { sessionId: "human", path: "/desktop/human", control: false, humanControl: true }
      : {},
  )
  render(<DesktopPanel bot={bot} api={f.api} />)
  await waitFor(() => expect(viewers).toHaveLength(1))
  const viewer = viewers[0]
  if (!viewer) throw new Error("Missing viewer")
  viewer.getImageData = () => ({ ...pulse(0), data: new Uint8ClampedArray(8 * 8 * 4) })
  await connected()
  expect(screen.queryByText("Você está no controle. O bot aguarda você terminar.")).toBeNull()
  expect(
    screen.getByText("O bot está aguardando. O controle ficará disponível quando a imagem chegar."),
  ).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Devolver ao bot" })).toBeEnabled()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
})

test("a disabled browser explains the real state and opens settings without changing consent", async () => {
  const f = fixture()
  render(<DesktopPanel bot={{ ...bot, browserEnabled: false, computerUse: false }} api={f.api} />)
  await connected()
  expect(screen.queryByText("Peça ao bot para abrir uma página. Ela aparecerá aqui na tela da VM.")).toBeNull()
  expect(screen.getByText("O navegador deste bot está desativado.")).toBeInTheDocument()
  expect(
    screen.getByText(
      "O controle automático do computador está desativado. Você ainda pode assumir o controle manualmente.",
    ),
  ).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Ativar navegador" })).toBeEnabled()
  expect(f.request.mock.calls.some(([route]) => route.startsWith("PATCH"))).toBe(false)
})

test("reconnect immediately reports progress, disables input and times out a missing session response", async () => {
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()
  f.request.mockImplementation(async (route) => (route === "POST /bots/:id/desktop" ? new Promise(() => {}) : {}))
  vi.useFakeTimers()
  fireEvent.click(screen.getByRole("button", { name: "Reconectar tela" }))
  expect(screen.getByRole("button", { name: "Reconectando tela…" })).toBeInTheDocument()
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  await act(async () => vi.advanceTimersByTimeAsync(30_100))
  expect(screen.getByText(/A VM não respondeu ao pedido da tela em 30 s/)).toBeInTheDocument()
  expect(screen.getByText("Não foi possível receber a imagem")).toBeInTheDocument()
})

test("takeover keeps pointer and keyboard input off until its own first frame", async () => {
  vi.useFakeTimers()
  const f = fixture()
  render(<DesktopPanel bot={bot} api={f.api} />)
  await act(async () => vi.advanceTimersByTimeAsync(10))
  await act(async () => viewers[0]?.dispatchEvent(new Event("connect")))
  fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }))
  await act(async () => vi.advanceTimersByTimeAsync(10))
  const viewer = viewers[1]
  if (!viewer) throw new Error("Missing takeover viewer")
  viewer.getImageData = () => ({ ...pulse(0), data: new Uint8ClampedArray(8 * 8 * 4) })
  await act(async () => viewer.dispatchEvent(new Event("connect")))
  expect(viewer.viewOnly).toBe(true)
  expect(screen.getByLabelText("Digitar na VM")).toBeDisabled()
  expect(screen.queryByText("Você está no controle")).toBeNull()
  viewer.getImageData = () => pulse(2)
  await act(async () => vi.advanceTimersByTimeAsync(1_000))
  expect(viewer.viewOnly).toBe(false)
  expect(screen.getByLabelText("Digitar na VM")).toBeEnabled()
  expect(screen.getByText("Você está no controle")).toBeInTheDocument()
})

test("the empty screen localizes assisted-decision fallback without internal markers", async () => {
  const f = fixture()
  f.request.mockImplementation(async (route: string, body: { control?: boolean }) => {
    if (route === "POST /bots/:id/desktop")
      return { sessionId: "session", path: "/api/v1/desktop/session/socket", control: body.control ?? false }
    if (route === "GET /browser/tabs")
      return {
        tabs: [],
        lastFailure: {
          tool: "browser_type",
          errorCode: "AMBIGUOUS_TARGET",
          error: "Two targets match.\nTOURI_BROWSER_DECISION_HINT|no_credit",
          at: 1,
        },
      }
    return {}
  })

  render(<DesktopPanel bot={bot} api={f.api} />)
  await connected()

  await waitFor(() => expect(screen.getByText(/A decisão assistida do navegador está sem crédito/)).toBeInTheDocument())
  expect(document.body.textContent).not.toContain("TOURI_BROWSER_DECISION_HINT")
  expect(document.body.textContent).not.toContain("Two targets match.")
})
