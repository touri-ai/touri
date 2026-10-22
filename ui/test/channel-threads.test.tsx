import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { getChannelThreadCards } from "../src/channelThreadCards"
import { getChannelThreads, getChannelThreadTitle } from "../src/channelThreads"
import { ChannelThreads } from "../src/components/ChannelThreads"

afterEach(cleanup)

const getFixture = () => {
  const state = createMockApi().getState()
  const base = state.threads[0]
  const message = state.messages[0]
  if (!base || !message) throw new Error("Missing synthetic conversation")
  const channel = { ...base, id: "channel", title: "Planejamento", groupId: "team", groupThreadId: null, createdAt: 1 }
  const routine = {
    ...channel,
    id: "routine",
    title: "Manhã · 10/22/26, 10:26 AM",
    createdAt: Date.UTC(2026, 9, 22, 12),
  }
  const privateThread = { ...routine, id: "private", groupThreadId: routine.id }
  const reply = {
    ...message,
    id: "reply",
    threadId: routine.id,
    role: "assistant" as const,
    text: "Resumo da manhã concluído.",
    createdAt: 10,
  }

  return { channel, routine, privateThread, reply }
}

it("shows routine activity in the channel and opens the shared conversation", () => {
  const { channel, routine, privateThread, reply } = getFixture()
  const select = vi.fn()

  render(
    <ChannelThreads groupId="team" threads={[routine, privateThread, channel]} messages={[reply]} onSelect={select} />,
  )
  fireEvent.click(screen.getByRole("button"))

  expect(screen.getByText("Resumo da manhã concluído.")).toBeVisible()
  expect(screen.getByRole("button")).toHaveTextContent("Manhã · 22 out")
  expect(select).toHaveBeenCalledWith(routine.id)
  expect(screen.queryByText("Planejamento")).toBeNull()
})

it("keeps the canonical channel stable and hides private provider threads", () => {
  const { channel, routine, privateThread, reply } = getFixture()

  const threads = getChannelThreads([routine, privateThread, channel], "team")
  const cards = getChannelThreadCards(threads, [reply, { ...reply, id: "older", createdAt: 5, text: "Antigo" }], "team")

  expect(threads.map((thread) => thread.id)).toEqual([channel.id, routine.id])
  expect(cards).toHaveLength(1)
  expect(cards[0]?.reply?.text).toBe(reply.text)
  expect(getChannelThreadTitle(routine)).not.toContain("10:26")
})
