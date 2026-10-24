import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it("a channel notice opened from Bots switches the sidebar to Work and keeps both drafts", async () => {
  localStorage.setItem("touri.sidebar.mode", "bots")
  const api = createMockApi()
  const { group } = await api.request("POST /groups", {
    name: "Equipe QA",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
  const channel = threads[0]
  if (!channel) throw new Error("Missing channel conversation")
  render(<App kernel={{ services: { api } }} />)
  const direct = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.change(direct, { target: { value: "Rascunho da conversa" } })
  expect(screen.getByRole("tab", { name: /^Bots/ })).toHaveAttribute("aria-selected", "true")

  act(() => {
    api.notify({ kind: "done", botId: "bot-onb", threadId: channel.id, title: "Concluído", body: "Relatório pronto." })
  })
  fireEvent.click(await screen.findByRole("button", { name: /^Notificações/ }))
  const center = await screen.findByRole("region", { name: "Central de notificações" })
  fireEvent.click(within(center).getByRole("button", { name: "Ver conversa" }))

  const channelInput = await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
  await waitFor(() => expect(screen.getByRole("tab", { name: /^Work/ })).toHaveAttribute("aria-selected", "true"))
  expect(screen.getByRole("tab", { name: /^Bots/ })).toHaveAttribute("aria-selected", "false")
  expect(localStorage.getItem("touri.sidebar.mode")).toBe("work")
  fireEvent.change(channelInput, { target: { value: "Rascunho do canal" } })

  fireEvent.click(screen.getByRole("tab", { name: /^Bots/ }))
  expect(await screen.findByRole("textbox", { name: "Mensagem para mark" })).toHaveValue("Rascunho da conversa")
  fireEvent.click(screen.getByRole("tab", { name: /^Work/ }))
  expect(await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })).toHaveValue("Rascunho do canal")
})
