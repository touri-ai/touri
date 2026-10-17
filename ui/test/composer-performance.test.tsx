import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }),
}))
vi.mock("../src/components/MarkdownContent", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/components/MarkdownContent")>()
  return { ...original, MarkdownContent: vi.fn(original.MarkdownContent) }
})

import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { t } from "../src/i18n"
import { requestTaskResume } from "../src/recoveryEvents"
import { createComposerPerformanceMessages } from "./e2e/composer-performance-fixture"

afterEach(cleanup)

test("typing in a long conversation does not render transcript Markdown", async () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const thread = state.threads.find((item) => item.id === "thread-mark")
  if (!bot || !thread) throw new Error("Missing fixture conversation")
  bot.machine = "vm"
  const messages = createComposerPerformanceMessages(thread.id)
  state.messages.splice(0, state.messages.length, ...messages)
  thread.activeLeafId = messages.at(-1)?.id ?? null
  render(<App kernel={{ services: { api } }} />)
  const input = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  // Settle focus/VM wake before measuring edits, as in the browser benchmark.
  await act(async () => fireEvent.focus(input))
  await waitFor(() => expect(MarkdownContent).toHaveBeenCalled())
  vi.mocked(MarkdownContent).mockClear()

  for (const value of ["a", "ab", "abc"]) fireEvent.change(input, { target: { value } })

  expect(input).toHaveValue("abc")
  expect(vi.mocked(MarkdownContent).mock.calls.length).toBe(0)
  expect(localStorage.getItem(`touri.composer-draft.v1:${thread.id}`)).toBe("abc")

  // The DOM-only renderer has no scroll layout, so update a reply in its first virtual window.
  const reply = messages[1]
  if (!reply) throw new Error("Missing synthetic reply")
  act(() =>
    api.emit({
      type: "message.updated",
      message: {
        ...reply,
        text: "Incoming synthetic reply",
        parts: [{ type: "text", text: "Incoming synthetic reply" }],
      },
    }),
  )
  await screen.findByText("Incoming synthetic reply")
  expect(input).toHaveValue("abc")
})

test("suggested prompts and task recovery fill and focus the local draft", async () => {
  const api = createMockApi()
  const state = api.getState()
  state.messages.splice(0)
  const thread = state.threads.find((item) => item.id === "thread-mark")
  if (!thread) throw new Error("Missing fixture conversation")
  thread.activeLeafId = null
  render(<App kernel={{ services: { api } }} />)
  const input = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(await screen.findByRole("button", { name: "Usar exemplo" }))
  expect(input).toHaveValue(t("onboarding.examplePrompt"))
  expect(input).toHaveFocus()

  fireEvent.change(input, { target: { value: "" } })
  act(() => requestTaskResume(thread.id))
  expect(input).toHaveValue(
    t(
      "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas.",
    ),
  )
  expect(input).toHaveFocus()
  fireEvent.change(input, { target: { value: "Edited draft" } })
  act(() => requestTaskResume(thread.id))
  expect(input).toHaveValue("Edited draft")
  expect(api.calls.some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
})
