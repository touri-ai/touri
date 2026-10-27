import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BrowserTakeoverView } from "../src/components/BrowserTakeoverView"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const getFixture = async (loadFrame = true, getImage = () => "data:image/png;base64,ZmFrZQ==") => {
  const request = vi.fn(async (route: string) => {
    if (route !== "POST /browser/tabs/:id/takeover/frame") return {}
    return {
      controlEpoch: "control",
      targetEpoch: 1,
      viewEpoch: 0,
      title: "",
      url: "https://example.test/form",
      image: getImage(),
      width: 800,
      height: 500,
    }
  })
  const api = Object.assign({}, createMockApi(), { request: request as ApiRequest })
  render(
    <BrowserTakeoverView
      api={api}
      tabId="tab"
      sessionId="session"
      controlEpoch="control"
      botName="Lia"
      locale="pt-BR"
      reason="Conclua a verificação fictícia."
      actions={[]}
      onHandback={vi.fn()}
    />,
  )
  if (loadFrame) fireEvent.load(await screen.findByRole("img", { name: "Página atual do navegador" }))

  return request
}

test("navigation is editable and remains scoped to the human control session", async () => {
  const request = await getFixture()
  const address = screen.getByRole("textbox", { name: "Endereço do navegador" })
  fireEvent.focus(address)
  fireEvent.change(address, { target: { value: "example.test/next" } })

  fireEvent.keyDown(address, { key: "Enter" })

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({
        sessionId: "session",
        input: { kind: "navigate", action: "goto", url: "https://example.test/next" },
      }),
      { id: "tab" },
    ),
  )
  fireEvent.click(screen.getByRole("button", { name: "Voltar página" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ input: { kind: "navigate", action: "back" } }),
      { id: "tab" },
    ),
  )
})

test("click focuses direct typing and drag sends selection phases without adding chat text", async () => {
  const request = await getFixture()
  const page = screen.getByRole("application", { name: "Página atual do navegador" })
  vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 500,
    width: 800,
    height: 500,
    toJSON: () => ({}),
  })

  fireEvent.pointerDown(page, { pointerId: 1, pointerType: "mouse", clientX: 40, clientY: 40, button: 0 })
  fireEvent.pointerMove(page, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 40 })
  fireEvent.pointerUp(page, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 40 })

  expect(screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })).toHaveFocus()
  await waitFor(() => expect(request.mock.calls.filter(([route]) => route.endsWith("/input"))).toHaveLength(3))
  expect(document.querySelector("details")).not.toHaveAttribute("open")
  expect(screen.getByText("Conclua a verificação fictícia.", { selector: "summary" })).toBeVisible()
})

test("rapid typing is batched and drained before handback without dropping characters", async () => {
  const request = await getFixture()
  const keyboard = screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
  const text = "texto fictício ".repeat(8)

  Array.from(text).forEach((character) => {
    fireEvent.input(keyboard, { target: { value: character } })
  })
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("DELETE /browser/tabs/:id/takeover/session", expect.anything(), { id: "tab" }),
  )
  const inputs = request.mock.calls.filter(([route]) => route.endsWith("/input"))
  expect(inputs).toHaveLength(1)
  expect(inputs[0]).toEqual([
    "POST /browser/tabs/:id/takeover/input",
    expect.objectContaining({ input: { kind: "text", text } }),
    { id: "tab" },
  ])
})

test("a hidden viewer waits for visibility before requesting even its first private frame", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true)

  const request = await getFixture(false)

  expect(request).not.toHaveBeenCalled()
  hidden.mockReturnValue(false)
  fireEvent(document, new Event("visibilitychange"))
  await screen.findByRole("img", { name: "Página atual do navegador" })
  expect(request).toHaveBeenCalledWith(
    "POST /browser/tabs/:id/takeover/frame",
    expect.objectContaining({ stream: true }),
    { id: "tab" },
    expect.anything(),
  )
})

test("a newer image from the same viewport keeps the displayed frame interactive while it decodes", async () => {
  let frames = 0
  const request = await getFixture(true, () => `data:image/png;base64,frame${frames++}`)
  const keyboard = screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.keyDown(keyboard, { key: "ArrowLeft", code: "ArrowLeft" })

  await waitFor(() =>
    expect(screen.getByRole("img", { name: "Página atual do navegador" })).toHaveAttribute(
      "src",
      "data:image/png;base64,frame1",
    ),
  )

  expect(screen.getByRole("button", { name: "Digitar no navegador" })).toBeEnabled()
  fireEvent.input(keyboard, { target: { value: "texto durante a atualização" } })
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Lia" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ input: { kind: "text", text: "texto durante a atualização" } }),
      { id: "tab" },
    ),
  )
})
