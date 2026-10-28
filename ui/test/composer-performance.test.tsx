import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import type * as ComposerModule from "../src/components/Composer"
import type * as MotionModule from "../src/components/Motion"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }),
}))
vi.mock("../src/components/MarkdownContent", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/components/MarkdownContent")>()
  return { ...original, MarkdownContent: vi.fn(original.MarkdownContent) }
})

vi.mock("../src/components/Composer", async (importOriginal) => {
  const original = await importOriginal<typeof ComposerModule>()
  return { ...original, Composer: vi.fn(original.Composer) }
})
vi.mock("../src/components/Motion", async (importOriginal) => {
  const original = await importOriginal<typeof MotionModule>()
  return { ...original, useInsertedIds: vi.fn(original.useInsertedIds) }
})

import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { useInsertedIds } from "../src/components/Motion"
import { t } from "../src/i18n"
import { requestTaskResume } from "../src/recoveryEvents"
import { createComposerPerformanceMessages } from "./e2e/composer-performance-fixture"

afterEach(cleanup)

test("late host metadata keeps typing independent of transcript rendering", async () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const thread = state.threads.find((item) => item.id === "thread-mark")
  if (!bot || !thread) throw new Error("Missing fixture conversation")
  bot.machine = "vm"
  const messages = createComposerPerformanceMessages(thread.id)
  // Completed provider replies are immutable. Use a live reply in the DOM-only
  // renderer's latest virtual window to exercise an actual incoming update.
  const reply = messages.at(-1)
  if (!reply) throw new Error("Missing synthetic reply")
  reply.status = "streaming"
  state.messages.splice(0, state.messages.length, ...messages)
  thread.activeLeafId = messages.at(-1)?.id ?? null
  const health = Promise.withResolvers<void>()
  const request: ApiRequest = async (route, input, path, transport) => {
    const response = await api.request(route, input, path, transport)
    if (route === "GET /health") await health.promise
    return response
  }
  render(<App kernel={{ services: { api: { ...api, request } } }} />)
  const input = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await screen.findByRole("heading", { name: "Synthetic review 250" })
  // Settle focus/VM wake before measuring edits, as in the browser benchmark.
  await act(async () => fireEvent.focus(input))
  await waitFor(() => expect(MarkdownContent).toHaveBeenCalled())
  await act(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  vi.mocked(MarkdownContent).mockClear()
  vi.mocked(useInsertedIds).mockClear()
  vi.mocked(Composer).mockClear()

  for (const value of ["a", "ab", "abc"]) fireEvent.change(input, { target: { value } })

  expect(input).toHaveValue("abc")
  expect(vi.mocked(MarkdownContent).mock.calls.length).toBe(0)
  expect(localStorage.getItem(`touri.composer-draft.v1:${thread.id}`)).toBe("abc")

  expect(Composer).toHaveBeenCalledTimes(3)
  vi.mocked(Composer).mockClear()

  await act(async () => health.resolve())

  expect(vi.mocked(useInsertedIds).mock.calls.filter(([, scope]) => scope === thread.id)).toHaveLength(0)
  expect(Composer).not.toHaveBeenCalled()
  expect(MarkdownContent).not.toHaveBeenCalled()

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
  await screen.findByText("Incoming synthetic reply", { selector: "p" })
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
