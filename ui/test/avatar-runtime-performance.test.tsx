import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Run } from "@touri/contracts"
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
vi.mock("../src/components/ToolCallList", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/components/ToolCallList")>()
  return { ...original, ToolCallList: vi.fn(original.ToolCallList) }
})

import { createMockApi } from "../src/api/mock"
import { type AvatarRuntime, AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { BotAvatar } from "../src/components/BotAvatar"
import { ChatPanel } from "../src/components/ChatPanel"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { MASCOT_DONE_MS } from "../src/components/mascotState"
import { ToolCallList } from "../src/components/ToolCallList"
import { createComposerPerformanceMessages } from "./e2e/composer-performance-fixture"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test("a bot completion expires during typing without rendering the unchanged conversation", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: true }))
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const thread = state.threads.find((item) => item.id === "thread-mark")
  if (!bot || !thread) throw new Error("Missing fixture conversation")
  const messages = createComposerPerformanceMessages(thread.id)
  const lastReply = messages.at(-1)
  if (!lastReply?.runId) throw new Error("Missing synthetic reply")
  const conversation = { ...thread, activeLeafId: lastReply.id }
  const completed: Run = {
    id: lastReply.runId,
    botId: bot.id,
    threadId: thread.id,
    provider: bot.provider,
    trigger: "import",
    requestMessageId: lastReply.parentId,
    replyMessageId: lastReply.id,
    externalTurnId: null,
    status: "succeeded",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: lastReply.createdAt,
    startedAt: lastReply.createdAt,
    finishedAt: lastReply.updatedAt,
  }
  const runs = [completed]
  const idle = async () => {}
  const getScene = (runtime: AvatarRuntime) => (
    <AvatarRuntimeProvider value={runtime}>
      <BotAvatar bot={bot} className="background-mascot" />
      <ChatPanel
        bot={bot}
        thread={conversation}
        messages={messages}
        runs={runs}
        api={api}
        computerGrant={null}
        onSend={idle}
        onRetry={idle}
        onCancel={idle}
        onSwitchBranch={idle}
        onComputerGrant={() => {}}
        onOpenTools={() => {}}
      />
    </AvatarRuntimeProvider>
  )
  const runtime: AvatarRuntime = {
    bots: [bot],
    threads: [],
    messages: [],
    runs: [],
    notifications: [],
    loading: true,
  }
  // Hydration updates the existing bot machine, while the new conversation starts at its baseline.
  const view = render(getScene(runtime))
  view.rerender(getScene({ ...runtime, threads: [conversation], messages, runs, loading: false }))
  const input = screen.getByRole("textbox", { name: "Mensagem para mark" })
  const backgroundMascot = view.container.querySelector(".background-mascot")
  const conversationMascot = view.container.querySelector(".chat-bot-chip .tb-avatar")
  fireEvent.focus(input)
  expect(backgroundMascot).toHaveAttribute("data-mascot-state", "done")
  expect(conversationMascot).toHaveAttribute("data-mascot-state", "listening")
  expect(MarkdownContent).toHaveBeenCalled()
  expect(ToolCallList).toHaveBeenCalled()
  vi.mocked(MarkdownContent).mockClear()
  vi.mocked(ToolCallList).mockClear()

  fireEvent.change(input, { target: { value: "a" } })
  act(() => vi.advanceTimersByTime(MASCOT_DONE_MS - 1))
  expect(backgroundMascot).toHaveAttribute("data-mascot-state", "done")
  fireEvent.change(input, { target: { value: "ab" } })
  act(() => vi.advanceTimersByTime(1))
  fireEvent.change(input, { target: { value: "abc" } })

  expect(backgroundMascot).toHaveAttribute("data-mascot-state", "listening")
  expect(conversationMascot).toHaveAttribute("data-mascot-state", "listening")
  expect(input).toHaveValue("abc")
  expect(localStorage.getItem(`touri.composer-draft.v1:${thread.id}`)).toBe("abc")
  expect(MarkdownContent).not.toHaveBeenCalled()
  expect(ToolCallList).not.toHaveBeenCalled()
})
