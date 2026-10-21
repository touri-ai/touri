import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { BotSettingsModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"
import { showBotSettings } from "./workspaceNavigation"

it("saves the bot name from General and updates navigation and chat", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  showBotSettings()
  const name = await screen.findByRole("textbox", { name: "Nome" })
  expect(name).toHaveValue("mark")
  fireEvent.change(name, { target: { value: " Bia QA Renomeada " } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await screen.findByRole("textbox", { name: "Mensagem para Bia QA Renomeada" })
  expect(screen.getByRole("button", { name: "Ações de Bia QA Renomeada" })).toBeVisible()
  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: expect.objectContaining({ name: "Bia QA Renomeada" }),
    pathValues: { id: "bot-mark" },
  })
  const bot = api.getState().bots.find((candidate) => candidate.id === "bot-mark")
  const thread = api.getState().threads.find((candidate) => candidate.id === "thread-mark")
  if (!bot || !thread) throw new Error("Missing bot/thread")
  const text = 'Bot renomeado de "Bia QA Renomeada" para "Bia no chat".'
  const notice: Message = {
    id: "rename-notice",
    threadId: thread.id,
    parentId: thread.activeLeafId,
    role: "system",
    kind: "notice",
    status: "complete",
    runId: null,
    text,
    parts: [{ type: "text", text }],
    sender: null,
    source: "local",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await act(async () => {
    api.emit({ type: "bot.updated", bot: { ...bot, name: "Bia no chat" } })
    api.emit({ type: "thread.updated", thread: { ...thread, activeLeafId: notice.id } })
    api.emit({ type: "message.created", message: notice })
  })
  expect(screen.getByRole("textbox", { name: "Mensagem para Bia no chat" })).toBeVisible()
  expect(screen.getByText(text, { selector: "p" })).toBeVisible()
}, 15_000)

it.each([
  ["   ", "Dê um nome ao bot."],
  ["a".repeat(81), "Use de 1 a 80 caracteres"],
  ["Bia\tQA", "Use de 1 a 80 caracteres"],
])("rejects an invalid name in settings: %j", async (value, message) => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const updateBot = vi.fn(async () => {})
  const close = vi.fn()
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={close}
    />,
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message))
  expect(updateBot).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})
