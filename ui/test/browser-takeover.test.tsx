import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BrowserTakeoverView } from "../src/components/BrowserTakeoverView"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const getBrowserFrame = (url = "https://exemplo.test/entrar") => ({
  controlEpoch: "control-epoch",
  targetEpoch: 1,
  viewEpoch: 0,
  title: "Página de teste",
  url,
  image: "data:image/png;base64,ZmFrZQ==",
  width: 1_000,
  height: 500,
})

const loadFirstBrowserFrame = async (): Promise<void> => {
  const image = await screen.findByRole("img", { name: "Página atual do navegador" })
  fireEvent.load(image)
}

test("keeps remote keyboard events inside the takeover control", async () => {
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return getBrowserFrame()
    return {}
  }) as ApiRequest
  const api = Object.assign({}, createMockApi(), { request })
  const onConversationInput = vi.fn()
  render(
    <form
      onInput={onConversationInput}
      onKeyDown={onConversationInput}
      onKeyUp={onConversationInput}
      onPaste={onConversationInput}
    >
      <BrowserTakeoverView
        api={api}
        tabId="synthetic-tab"
        sessionId="synthetic-session"
        controlEpoch="control-epoch"
        botName="Lia"
        locale="pt-BR"
        reason={null}
        actions={[]}
        onHandback={vi.fn()}
      />
    </form>,
  )
  await loadFirstBrowserFrame()
  const keyboard = screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })

  fireEvent.pointerDown(screen.getByRole("button", { name: "Digitar no navegador" }))
  expect(keyboard).toHaveFocus()
  fireEvent.keyDown(keyboard, { key: "ArrowLeft", code: "ArrowLeft" })
  fireEvent.keyUp(keyboard, { key: "ArrowLeft", code: "ArrowLeft" })
  fireEvent.keyDown(keyboard, { key: "v", ctrlKey: true })
  fireEvent.keyUp(keyboard, { key: "v", ctrlKey: true })
  fireEvent.keyDown(keyboard, { key: "v", metaKey: true })
  fireEvent.keyUp(keyboard, { key: "v", metaKey: true })
  fireEvent.keyDown(keyboard, { key: "Process", isComposing: true })
  fireEvent.keyUp(keyboard, { key: "Process", isComposing: true })
  fireEvent.input(keyboard, { target: { value: "texto fictício" } })
  fireEvent.paste(keyboard, { clipboardData: { getData: () => "colagem fictícia" } })

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ input: { kind: "text", text: "colagem fictícia" } }),
      { id: "synthetic-tab" },
    ),
  )
  expect(onConversationInput).not.toHaveBeenCalled()
  expect(keyboard).toHaveValue("")
})

test("sends private browser typing only to the remote input route and returns control", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame")
      return getBrowserFrame("https://user:senha@exemplo.test/entrar?token=segredo#parte")
    return {}
  }) as ApiRequest
  api.request = request

  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason="O site pediu login para mostrar o preço final."
      actions={[{ id: "read", icon: "◉", label: "Leu a página", time: "21:12", active: true }]}
      onHandback={vi.fn()}
    />,
  )

  await waitFor(() => expect(document.body.textContent).toContain("https://exemplo.test"))
  await loadFirstBrowserFrame()
  const keyboard = await screen.findByRole("textbox", { name: "Entrada de teclado para o navegador" })
  const browserUrl = document.querySelector(".browser-takeover-toolbar span")
  expect(browserUrl).toHaveAttribute("title", "https://exemplo.test")
  expect(document.body.textContent).not.toContain("/entrar")
  expect(document.body.textContent).not.toContain("senha")
  expect(document.body.textContent).not.toContain("segredo")
  fireEvent.input(keyboard, { target: { value: "valor privado de teste" } })

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      {
        sessionId: "synthetic-session",
        controlEpoch: "control-epoch",
        targetEpoch: 1,
        viewEpoch: 0,
        width: 1_000,
        height: 500,
        input: { kind: "text", text: "valor privado de teste" },
      },
      { id: "synthetic-tab" },
    ),
  )
  expect(keyboard).toHaveValue("")
  expect(document.body.textContent).not.toContain("valor privado de teste")

  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "DELETE /browser/tabs/:id/takeover/session",
      { sessionId: "synthetic-session", controlEpoch: "control-epoch" },
      { id: "synthetic-tab" },
    ),
  )
})

test("handback drains accepted phone typing, paste and keyboard input before returning control", async () => {
  const pendingInput = Promise.withResolvers<void>()
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return getBrowserFrame()
    if (route === "POST /browser/tabs/:id/takeover/input") await pendingInput.promise
    return {}
  })
  const api = Object.assign({}, createMockApi(), { request: request as ApiRequest })
  const onHandback = vi.fn()

  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={onHandback}
    />,
  )
  await loadFirstBrowserFrame()
  const keyboard = screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.input(keyboard, { target: { value: "entrada privada inicial" } })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ input: { kind: "text", text: "entrada privada inicial" } }),
      { id: "synthetic-tab" },
    ),
  )

  fireEvent.input(keyboard, { target: { value: "entrada privada final" } })
  fireEvent.paste(keyboard, { clipboardData: { getData: () => "texto colado privado" } })
  fireEvent.keyDown(keyboard, { key: "Enter", code: "Enter" })
  fireEvent.keyUp(keyboard, { key: "Enter", code: "Enter" })
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))
  fireEvent.input(keyboard, { target: { value: "entrada depois de devolver" } })
  expect(screen.getByRole("button", { name: "Devolvendo o controle…" })).toBeDisabled()
  expect(onHandback).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalledWith("DELETE /browser/tabs/:id/takeover/session", expect.anything(), {
    id: "synthetic-tab",
  })
  pendingInput.resolve()

  await waitFor(() => expect(onHandback).toHaveBeenCalledOnce())

  const actions = request.mock.calls.filter(([route]) => route !== "POST /browser/tabs/:id/takeover/frame")
  const getInputRequest = (input: unknown) => [
    "POST /browser/tabs/:id/takeover/input",
    {
      sessionId: "synthetic-session",
      controlEpoch: "control-epoch",
      targetEpoch: 1,
      viewEpoch: 0,
      width: 1_000,
      height: 500,
      input,
    },
    { id: "synthetic-tab" },
  ]
  expect(actions).toEqual([
    getInputRequest({ kind: "text", text: "entrada privada inicial" }),
    getInputRequest({ kind: "text", text: "entrada privada final" }),
    getInputRequest({ kind: "text", text: "texto colado privado" }),
    getInputRequest({ kind: "key", phase: "down", key: "Enter", code: "Enter", modifiers: 0 }),
    getInputRequest({ kind: "key", phase: "up", key: "Enter", code: "Enter", modifiers: 0 }),
    [
      "DELETE /browser/tabs/:id/takeover/session",
      { sessionId: "synthetic-session", controlEpoch: "control-epoch" },
      { id: "synthetic-tab" },
    ],
  ])
  expect(keyboard).toHaveValue("")
  expect(document.body.textContent).not.toContain("entrada privada")
  expect(document.body.textContent).not.toContain("texto colado privado")
})

test("keeps the privacy notice visible and lets a person expand the browser view", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return Object.assign({}, getBrowserFrame(), { url: "" })
    return {}
  }) as ApiRequest
  api.request = request

  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason="O site pediu login para mostrar o preço final."
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  const privacy = screen.getByRole("status", { name: "Privacidade do navegador" })
  expect(privacy).toHaveTextContent("O que você digitar aqui não vai para o chat, o bot nem o histórico.")
  expect(screen.getAllByText("O que você digitar aqui não vai para o chat, o bot nem o histórico.")).toHaveLength(1)
  await screen.findByText("Você está no controle · Lia está pausado", { exact: true })
  expect(screen.queryByText("Conectando ao navegador…")).toBeNull()
  const expand = screen.getByRole("button", { name: "Expandir navegador em tela cheia" })
  fireEvent.click(expand)

  expect(screen.getByRole("region", { name: "Controle remoto do navegador" })).toHaveAttribute("data-full-view", "true")
})

test("a reconnected browser view requests frames at its retained viewport epoch", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string, body?: unknown) => {
    if (route !== "POST /browser/tabs/:id/takeover/frame") return {}
    const viewEpoch = (body as { viewEpoch: number }).viewEpoch
    return { ...getBrowserFrame(), viewEpoch }
  }) as ApiRequest
  api.request = request

  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      initialViewEpoch={7}
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  await loadFirstBrowserFrame()
  expect(request).toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/frame",
    { sessionId: "synthetic-session", controlEpoch: "control-epoch", viewEpoch: 7 },
    { id: "synthetic-tab" },
  )
})

test("disconnecting the takeover view leaves the browser paused for reconnection", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) =>
    route === "POST /browser/tabs/:id/takeover/frame" ? getBrowserFrame() : {},
  ) as ApiRequest
  api.request = request

  const { unmount } = render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  await loadFirstBrowserFrame()
  const keyboard = await screen.findByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.input(keyboard, { target: { value: "texto privado pendente" } })
  unmount()
  await Promise.resolve()

  expect(request).not.toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/input", expect.anything(), {
    id: "synthetic-tab",
  })
  expect(request).not.toHaveBeenCalledWith("DELETE /browser/tabs/:id/takeover/session", expect.anything(), {
    id: "synthetic-tab",
  })
})

test("turns phone drags into remote scrolling and phone taps into browser clicks", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return getBrowserFrame()
    return {}
  }) as ApiRequest
  api.request = request

  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  await loadFirstBrowserFrame()
  const page = document.querySelector(".browser-takeover-screen")
  if (!page) throw new Error("The remote browser frame should be rendered")
  page.getBoundingClientRect = vi.fn(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: 1_000,
        height: 500,
        right: 1_000,
        bottom: 500,
        toJSON: vi.fn(),
      }) as DOMRect,
  )

  const dispatchTouch = (type: string, x: number, y: number): void => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, "pointerId", { value: 1 })
    Object.defineProperty(event, "pointerType", { value: "touch" })
    Object.defineProperty(event, "clientX", { value: x })
    Object.defineProperty(event, "clientY", { value: y })
    page.dispatchEvent(event)
  }

  dispatchTouch("pointerdown", 120, 140)
  dispatchTouch("pointermove", 120, 220)
  dispatchTouch("pointerup", 120, 220)

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({
        sessionId: "synthetic-session",
        input: expect.objectContaining({ kind: "wheel", deltaY: -80 }),
      }),
      { id: "synthetic-tab" },
    ),
  )
  expect(request).not.toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/input",
    expect.objectContaining({ input: expect.objectContaining({ kind: "click" }) }),
    { id: "synthetic-tab" },
  )

  dispatchTouch("pointerdown", 250, 160)
  dispatchTouch("pointerup", 250, 160)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({
        sessionId: "synthetic-session",
        input: expect.objectContaining({ kind: "click", x: 0.25, y: 0.32, button: "left" }),
      }),
      { id: "synthetic-tab" },
    ),
  )
})

test("intercepts paste text without forwarding the paste shortcut to the page", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) =>
    route === "POST /browser/tabs/:id/takeover/frame" ? getBrowserFrame() : {},
  ) as ApiRequest
  api.request = request
  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  await loadFirstBrowserFrame()
  const keyboard = await screen.findByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.keyDown(keyboard, { key: "v", code: "KeyV", ctrlKey: true })
  fireEvent.paste(keyboard, {
    clipboardData: { getData: () => "texto colado privado" },
  })

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      {
        sessionId: "synthetic-session",
        controlEpoch: "control-epoch",
        targetEpoch: 1,
        viewEpoch: 0,
        width: 1_000,
        height: 500,
        input: { kind: "text", text: "texto colado privado" },
      },
      { id: "synthetic-tab" },
    ),
  )
  expect(request).not.toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/input",
    expect.objectContaining({ input: expect.objectContaining({ kind: "key", key: "v" }) }),
    { id: "synthetic-tab" },
  )
})

test("rejects oversized text before encoding or sending it to the browser", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) =>
    route === "POST /browser/tabs/:id/takeover/frame" ? getBrowserFrame() : {},
  ) as ApiRequest
  api.request = request
  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )

  await loadFirstBrowserFrame()
  const keyboard = await screen.findByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.input(keyboard, { target: { value: "x".repeat(16_385) } })

  expect(await screen.findByRole("alert")).toHaveTextContent("Esse texto é longo demais para enviar ao navegador.")
  expect(request).not.toHaveBeenCalledWith("POST /browser/tabs/:id/takeover/input", expect.anything(), {
    id: "synthetic-tab",
  })
})

test("maps phone full-screen clicks to the contained page and ignores its margins", async () => {
  const api = createMockApi()
  const request = vi.fn(async (route: string) =>
    route === "POST /browser/tabs/:id/takeover/frame" ? getBrowserFrame() : {},
  )
  api.request = request as ApiRequest
  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-session"
      controlEpoch="control-epoch"
      botName="Lia"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )
  await loadFirstBrowserFrame()
  const page = document.querySelector(".browser-takeover-screen")
  const image = screen.getByRole("img", { name: "Página atual do navegador" })
  if (!page || !(image instanceof HTMLImageElement)) throw new Error("The browser page should be rendered")
  image.style.objectFit = "contain"
  page.getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, 512, 512))

  fireEvent(page, new MouseEvent("pointerdown", { bubbles: true, clientX: 128, clientY: 192 }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ input: { kind: "click", x: 0.25, y: 0.25, button: "left" } }),
      { id: "synthetic-tab" },
    ),
  )

  fireEvent(page, new MouseEvent("pointerdown", { bubbles: true, clientX: 128, clientY: 40 }))
  await Promise.resolve()

  expect(request.mock.calls.filter(([route]) => route === "POST /browser/tabs/:id/takeover/input")).toHaveLength(1)
})
