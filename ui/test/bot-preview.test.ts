import type { Message } from "@touri/contracts"
import { expect, it } from "vitest"
import { getRoutineConversationFixture } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"

it("shows the localized no-news result in a routine thread preview", () => {
  const { thread, messages, run } = getRoutineConversationFixture()
  const preview = latestPreview({ threadIds: [thread.id], messages, runs: [run] })

  expect(preview).toBe("Sem novidades nesta execução")
  expect(preview).not.toContain("NO_NOTIFICATION")
})

it("keeps a no-news token when an ordinary reply mentions it", () => {
  const { thread, messages } = getRoutineConversationFixture()
  const reply = messages.find((message) => message.role === "assistant")
  if (!reply) throw new Error("Missing routine reply")
  const text = "O marcador NO_NOTIFICATION aparece nesta explicação."
  const explainedReply: Message = { ...reply, runId: null, text, parts: [{ type: "text", text }] }
  const explainedMessages = messages.map((message) => (message.id === reply.id ? explainedReply : message))
  const preview = latestPreview({ threadIds: [thread.id], messages: explainedMessages })

  expect(preview).toBe(text)
})
