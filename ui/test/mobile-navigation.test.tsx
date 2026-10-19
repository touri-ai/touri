import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

afterEach(() => vi.restoreAllMocks())

const phoneViewport = () => {
  const media = window.matchMedia("(max-width: 620px)")
  let narrow = true
  let changed = () => {}
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === media.media
      ? {
          ...media,
          get matches() {
            return narrow
          },
          addEventListener: vi.fn((_event, listener) => {
            const previous = changed
            const next = listener as () => void
            changed = () => {
              previous()
              next()
            }
          }),
          removeEventListener: vi.fn(),
        }
      : { ...media, media: query },
  )
  // JSDOM has no native dialog methods; browser tests cover modal focus and inertness.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
      },
    },
  })
  return () => {
    narrow = false
    changed()
  }
}

it("opens phone navigation and closes it when choosing a conversation", async () => {
  phoneViewport()
  const api = createMockApi()
  const state = api.getState()
  const thread = state.threads.find((thread) => thread.id === "thread-mark")
  if (!thread) throw new Error("Missing conversation fixture")
  state.threads.push({ ...thread, id: "thread-next", title: "Next conversation", activeLeafId: null })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const menu = screen.getByRole("button", { name: "Abrir menu" })
  expect(menu).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("navigation", { name: "Barra lateral" })).toBeNull()
  fireEvent.click(menu)
  const drawer = screen.getByRole("dialog", { name: "Barra lateral" })
  expect(menu).toHaveAttribute("aria-controls", drawer.id)
  expect(menu).toHaveAttribute("aria-expanded", "true")
  expect(within(drawer).getByRole("button", { name: "Fechar menu" })).toHaveFocus()
  expect(within(drawer).getByRole("button", { name: "Buscar conversas" })).toBeVisible()
  expect(within(drawer).getByRole("button", { name: "Criar bot" })).toBeVisible()
  expect(within(drawer).getByRole("button", { name: /Notificações/ })).toBeVisible()
  fireEvent.click(within(drawer).getByRole("button", { name: /Next conversation/ }))
  await waitFor(() =>
    expect(
      api.calls.some((call) => call.route === "GET /threads/:id/messages" && call.pathValues.id === "thread-next"),
    ).toBe(true),
  )
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  expect(menu).toHaveAttribute("aria-expanded", "false")
  expect(menu).toHaveFocus()
})

it("closes for search and bot creation, and restores desktop navigation on resize", async () => {
  const desktop = phoneViewport()
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const menu = screen.getByRole("button", { name: "Abrir menu" })
  fireEvent.click(menu)
  fireEvent.click(screen.getByRole("button", { name: "Buscar conversas" }))
  expect(await screen.findByRole("combobox", { name: "Buscar bots, conversas e configurações" })).toHaveFocus()
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  fireEvent.keyDown(window, { key: "Escape" })
  fireEvent.click(menu)
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  expect(await screen.findByRole("dialog", { name: "Criar um bot" })).toBeVisible()
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
  fireEvent.click(menu)
  act(desktop)
  expect(screen.queryByRole("button", { name: "Abrir menu" })).toBeNull()
  expect(screen.getByRole("navigation", { name: "Barra lateral" })).toBeVisible()
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
})

it("keeps notifications inside the modal and restores focus after navigation, cancellation or backdrop dismissal", async () => {
  phoneViewport()
  const api = createMockApi()
  api.notify({ kind: "question", botId: "bot-mark", title: "Choose a task", body: "Which task is next?" })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const menu = screen.getByRole("button", { name: "Abrir menu" })
  fireEvent.click(menu)
  const drawer = screen.getByRole("dialog", { name: "Barra lateral" })
  fireEvent.click(within(drawer).getByRole("button", { name: /^Notificações/ }))
  const notifications = within(drawer).getByRole("region", { name: "Central de notificações" })
  expect(notifications).toBeVisible()
  fireEvent.click(within(notifications).getByRole("button", { name: "Abrir", exact: true }))
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  expect(menu).toHaveFocus()
  fireEvent.click(menu)
  fireEvent(screen.getByRole("dialog", { name: "Barra lateral" }), new Event("cancel", { cancelable: true }))
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  expect(menu).toHaveFocus()
  fireEvent.click(menu)
  fireEvent.click(screen.getByRole("dialog", { name: "Barra lateral" }))
  expect(screen.queryByRole("dialog", { name: "Barra lateral" })).toBeNull()
  expect(menu).toHaveFocus()
})
