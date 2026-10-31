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
      expect.objectContaining({ input: { kind: "text", text: "texto fictíciocolagem fictícia" } }),
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

  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Endereço do navegador" })).toHaveValue("https://exemplo.test/entrar"),
  )
  await loadFirstBrowserFrame()
  const keyboard = await screen.findByRole("textbox", { name: "Entrada de teclado para o navegador" })
  expect(screen.getByRole("textbox", { name: "Endereço do navegador" })).toHaveValue("https://exemplo.test/entrar")
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
    getInputRequest({ kind: "text", text: "entrada privada finaltexto colado privado" }),
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

test("a failed handback cancels observation and a retry starts it again", async () => {
  const release = vi.fn().mockRejectedValueOnce(new Error("Synthetic release failure")).mockResolvedValue({})
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return getBrowserFrame()
    if (route === "DELETE /browser/tabs/:id/takeover/session") return release()
    return {}
  }) as ApiRequest
  const api = Object.assign({}, createMockApi(), { request })
  const onHandbackStart = vi.fn()
  const onHandbackError = vi.fn()
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
      onHandbackStart={onHandbackStart}
      onHandbackError={onHandbackError}
      onHandback={onHandback}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() => expect(onHandbackError).toHaveBeenCalledOnce())
  expect(onHandbackStart).toHaveBeenCalledOnce()
  expect(onHandback).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() => expect(onHandback).toHaveBeenCalledOnce())
  expect(onHandbackStart).toHaveBeenCalledTimes(2)
  expect(onHandbackError).toHaveBeenCalledOnce()
})

test("keeps one privacy notice in details and lets a person expand the browser view", async () => {
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

  fireEvent.click(document.querySelector(".browser-takeover-aside summary") as HTMLElement)
  const privacy = screen.getByRole("status", { name: "Privacidade do navegador" })
  expect(privacy).toHaveTextContent("você está usando")
  expect(
    screen.getByRole("button", { name: "Cancelar", exact: true }).closest(".browser-takeover-controls"),
  ).not.toBeNull()
  expect(screen.getByRole("button", { name: "Devolver para Lia" }).closest(".browser-takeover-controls")).not.toBeNull()
  expect(
    screen.getAllByText(
      "Pessoas com acesso veem a página ao vivo. A digitação fica fora do histórico e do contexto do bot.",
    ),
  ).toHaveLength(1)
  await screen.findByText("você está usando", { exact: true })
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
    { sessionId: "synthetic-session", controlEpoch: "control-epoch", stream: true, viewEpoch: 7 },
    { id: "synthetic-tab" },
    { signal: expect.any(AbortSignal) },
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
      expect.objectContaining({ input: { kind: "pointer", phase: "down", x: 0.25, y: 0.25, button: "left" } }),
      { id: "synthetic-tab" },
    ),
  )

  fireEvent(page, new MouseEvent("pointerdown", { bubbles: true, clientX: 128, clientY: 40 }))
  await Promise.resolve()

  expect(request.mock.calls.filter(([route]) => route === "POST /browser/tabs/:id/takeover/input")).toHaveLength(1)
})

test("phone text stays local and focused during a viewport refresh and is flushed before the next key", async () => {
  const refreshed = Promise.withResolvers<void>()
  const request = vi.fn(async (route: string, body?: unknown) => {
    if (route !== "POST /browser/tabs/:id/takeover/frame") return {}
    const viewEpoch = (body as { viewEpoch: number }).viewEpoch
    if (viewEpoch > 0) await refreshed.promise
    return Object.assign({}, getBrowserFrame(), { viewEpoch })
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
  fireEvent.pointerDown(screen.getByRole("button", { name: "Digitar no navegador" }))

  fireEvent(window, new Event("orientationchange"))
  fireEvent.input(keyboard, { target: { value: "rascunho privado fictício" } })
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  expect(keyboard).toBeEnabled()
  expect(keyboard).toHaveFocus()
  expect(keyboard).toHaveValue("rascunho privado fictício")
  expect(onHandback).not.toHaveBeenCalled()
  expect(request.mock.calls.some(([route]) => route === "POST /browser/tabs/:id/takeover/input")).toBe(false)

  refreshed.resolve()
  await waitFor(() => expect(screen.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled())
  fireEvent.keyDown(keyboard, { key: "Enter", code: "Enter" })

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ viewEpoch: 1, input: { kind: "text", text: "rascunho privado fictício" } }),
      { id: "synthetic-tab" },
    ),
  )
  expect(keyboard).toHaveValue("")
})

test("cancel discards unsent typing before returning browser control", async () => {
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return getBrowserFrame()
    return {}
  }) as ApiRequest
  const api = Object.assign({}, createMockApi(), { request })
  const onHandback = vi.fn()
  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-cancel-session"
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

  fireEvent.input(keyboard, { target: { value: "digitação fictícia ainda não enviada" } })
  fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }))

  await waitFor(() => expect(onHandback).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith(
    "DELETE /browser/tabs/:id/takeover/session",
    { sessionId: "synthetic-cancel-session", controlEpoch: "control-epoch" },
    { id: "synthetic-tab" },
  )
  expect(request).not.toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/input",
    expect.anything(),
    expect.anything(),
  )
})

test("the last preview and address remain visible without granting input while control connects", async () => {
  const firstFrame = Promise.withResolvers<ReturnType<typeof getBrowserFrame>>()
  const request = vi.fn(async (route: string) => {
    if (route === "POST /browser/tabs/:id/takeover/frame") return firstFrame.promise
    return {}
  }) as ApiRequest
  const api = Object.assign({}, createMockApi(), { request })
  render(
    <BrowserTakeoverView
      api={api}
      tabId="synthetic-tab"
      sessionId="synthetic-preview-session"
      controlEpoch="control-epoch"
      botName="Lia"
      initialPreview="data:image/png;base64,ZmFrZQ=="
      initialAddress="exemplo.test"
      locale="pt-BR"
      reason={null}
      actions={[]}
      onHandback={vi.fn()}
    />,
  )
  const preview = screen.getByRole("img", { name: "Última página do navegador" })

  fireEvent.load(preview)
  fireEvent.pointerDown(screen.getByRole("application"), { pointerId: 1, clientX: 10, clientY: 10 })

  expect(preview).toBeVisible()
  expect(screen.getByRole("textbox", { name: "Endereço do navegador" })).toHaveValue("exemplo.test")
  expect(screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })).toBeDisabled()
  expect(request).not.toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/input",
    expect.anything(),
    expect.anything(),
  )
  firstFrame.resolve(getBrowserFrame())
  await loadFirstBrowserFrame()
  await waitFor(() => expect(screen.queryByRole("img", { name: "Última página do navegador" })).toBeNull())
})
