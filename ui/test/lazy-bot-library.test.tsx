import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

const libraryLoad = vi.hoisted(() => Promise.withResolvers<void>())
vi.mock("../src/components/BotLibrary", () => ({
  BotLibrary: () => {
    throw libraryLoad.promise
  },
}))

afterEach(() => {
  cleanup()
  libraryLoad.resolve()
})

test("keeps panel tabs and closing available while the library loads", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const toggle = screen.getByRole("button", { name: "Painel do bot", exact: true })
  fireEvent.click(toggle)
  const panel = await screen.findByRole("complementary", { name: "Painel de mark" })

  fireEvent.click(within(panel).getByRole("tab", { name: "Biblioteca", exact: true }))

  expect(within(panel).getByRole("tab", { name: "Biblioteca", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(within(panel).getByRole("button", { name: "Fechar painel do bot", exact: true })).toBeVisible()
  expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

  fireEvent.click(within(panel).getByRole("tab", { name: "Detalhes", exact: true }))

  expect(within(panel).getByRole("tab", { name: "Detalhes", exact: true })).toHaveAttribute("aria-selected", "true")

  fireEvent.click(within(panel).getByRole("button", { name: "Fechar painel do bot", exact: true }))

  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull())
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  await waitFor(() => expect(toggle).toHaveFocus())
})
