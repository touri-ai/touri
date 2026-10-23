import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { getChannelThreadCards } from "../src/channelThreadCards"
import { getChannelSidebarThreads, getChannelThreads, getChannelThreadTitle } from "../src/channelThreads"
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

it("keeps a newly appended routine visible when the channel already has fifty conversations", () => {
  const { channel, routine } = getFixture()
  const older = Array.from({ length: 50 }, (_, index) => ({ ...routine, id: `older-${index}`, updatedAt: index + 1 }))
  const newest = { ...routine, id: "newest-routine", updatedAt: 100 }

  const cards = getChannelThreadCards([channel, ...older, newest], [], "team")

  expect(cards).toHaveLength(50)
  expect(cards[0]?.thread.id).toBe(newest.id)
  expect(cards.some(({ thread }) => thread.id === "older-0")).toBe(false)
})

it("formats stored routine titles in Portuguese and English without US times", () => {
  const { routine } = getFixture()

  const portuguese = getChannelThreadTitle(routine, "pt-BR")
  const english = getChannelThreadTitle(routine, "en")

  expect(portuguese).toBe("Manhã · 22 out")
  expect(english).toBe("Manhã · Oct 22")
  expect(portuguese).not.toMatch(/AM|PM|\d{1,2}\/\d{1,2}\/\d{2}|\d{1,2}:\d{2}/)
  expect(english).not.toMatch(/AM|PM|\d{1,2}\/\d{1,2}\/\d{2}|\d{1,2}:\d{2}/)
})

it("omits children that repeat the channel name while keeping routines and named conversations", () => {
  const { channel, routine } = getFixture()
  const duplicate = { ...channel, id: "duplicate", title: " planejamento ", createdAt: 2 }
  const conversation = { ...channel, id: "named", title: "Roteiro", createdAt: 3 }

  const children = getChannelSidebarThreads([duplicate, conversation, routine, channel], {
    id: "team",
    name: "Planejamento",
  })

  expect(children.map((thread) => thread.id)).toEqual([conversation.id, routine.id])
})
