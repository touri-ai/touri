import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

const panelModule = vi.hoisted(() => Promise.withResolvers<{ GroupPanel: () => null }>())
vi.mock("../src/components/GroupPanel", () => panelModule.promise)

afterEach(() => {
  cleanup()
  panelModule.resolve({ GroupPanel: () => null })
})

test("lets a person close the channel panel while its module is still loading", async () => {
  const api = createMockApi()
  await api.request("POST /groups", {
    name: "Produto",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
  const channels = await screen.findByRole("region", { name: "Canais" })
  fireEvent.click(within(channels).getByRole("button", { name: /^Produto/ }))
  await screen.findByRole("textbox", { name: "Mensagem para Produto" })

  const toggle = await screen.findByRole("button", { name: /^Membros do canal:/ })
  fireEvent.click(toggle)
  const loading = await screen.findByRole("complementary", { name: "Carregando…" })
  expect(loading).toHaveAttribute("aria-busy", "true")
  fireEvent.click(within(loading).getByRole("button", { name: "Fechar painel do canal" }))

  await waitFor(() => expect(screen.queryByRole("complementary", { name: "Carregando…" })).toBeNull())
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  await waitFor(() => expect(toggle).toHaveFocus())
  expect(screen.getByRole("textbox", { name: "Mensagem para Produto" })).toBeVisible()
})
