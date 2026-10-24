import { cleanup, render, screen } from "@testing-library/react"
import { memo } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import {
  type AvatarRuntime,
  AvatarRuntimeProvider,
  useAvatarBot,
  useAvatarMood,
  useThreadBot,
} from "../src/components/AvatarRuntime"

afterEach(cleanup)

test("avatar readers skip unrelated updates and still follow bot, thread and loading changes", () => {
  const state = createMockApi().getState()
  const bot = state.bots.find((item) => item.id === "bot-mark")
  const otherBot = state.bots.find((item) => item.id !== bot?.id)
  const thread = state.threads.find((item) => item.id === "thread-mark")
  if (!bot || !otherBot || !thread) throw new Error("Missing synthetic conversation")
  const runtime: AvatarRuntime = {
    bots: [bot, otherBot],
    threads: [thread],
    messages: [],
    runs: [],
    notifications: [],
    loading: false,
  }
  const getBotView = vi.fn(() => {
    const selected = useAvatarBot(bot.id)
    return <output aria-label="Bot">{selected?.name ?? "missing"}</output>
  })
  const getThreadView = vi.fn(() => {
    const selected = useThreadBot(thread.id)
    return <output aria-label="Conversation bot">{selected?.name ?? "missing"}</output>
  })
  const getMoodView = vi.fn(() => {
    const mood = useAvatarMood(bot)
    return <output aria-label="Mood">{mood}</output>
  })
  const BotView = memo(getBotView)
  const ThreadView = memo(getThreadView)
  const MoodView = memo(getMoodView)
  const getScene = (value: AvatarRuntime) => (
    <AvatarRuntimeProvider value={value}>
      <BotView />
      <ThreadView />
      <MoodView />
    </AvatarRuntimeProvider>
  )
  const view = render(getScene(runtime))
  getBotView.mockClear()
  getThreadView.mockClear()
  getMoodView.mockClear()

  const unrelatedMessages = state.messages.filter((message) => message.threadId !== thread.id)
  view.rerender(getScene({ ...runtime, messages: unrelatedMessages }))

  expect(getBotView).not.toHaveBeenCalled()
  expect(getThreadView).not.toHaveBeenCalled()
  expect(getMoodView).not.toHaveBeenCalled()

  const renamed = { ...runtime, bots: [{ ...bot, name: "Novo nome" }, otherBot] }
  view.rerender(getScene(renamed))

  expect(screen.getByLabelText("Bot")).toHaveTextContent("Novo nome")
  expect(screen.getByLabelText("Conversation bot")).toHaveTextContent("Novo nome")

  view.rerender(getScene({ ...renamed, threads: [{ ...thread, botId: otherBot.id }], loading: true }))

  expect(screen.getByLabelText("Conversation bot")).toHaveTextContent(otherBot.name)
  expect(screen.getByLabelText("Mood")).toHaveTextContent("connecting")

  view.rerender(getScene({ ...runtime, bots: [], threads: [] }))

  expect(screen.getByLabelText("Bot")).toHaveTextContent("missing")
  expect(screen.getByLabelText("Conversation bot")).toHaveTextContent("missing")
  expect(screen.getByLabelText("Mood")).toHaveTextContent("idle")
})
