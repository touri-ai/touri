import type { Message } from "@touri/contracts"
import { expect, it } from "vitest"
import { getRoutineConversationFixture } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"
import { getBrowserTurnMessage } from "./browser-turn-fixture"

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

it("prefers readable canceled message text over its text parts and cancellation notice", () => {
  const message = getBrowserTurnMessage({ text: "Resultado parcial preservado." })

  const preview = latestPreview({ threadIds: [message.threadId], messages: [message] })

  expect(preview).toBe(message.text)
})

it("uses a readable text part when the canceled message text is blank", () => {
  const message = getBrowserTurnMessage({ text: " \n " })

  const preview = latestPreview({ threadIds: [message.threadId], messages: [message] })

  expect(preview).toBe("Encontrei duas opções fictícias antes de parar.")
})

it.each<{ parts: Message["parts"] }>([
  { parts: [] },
  { parts: [{ type: "text", text: " \n " }] },
  { parts: [{ type: "notice", code: "run_canceled", level: "warning", text: "canceled: Turno cancelado" }] },
])("uses the localized cancellation fallback only when there is no readable text (%j)", ({ parts }) => {
  const message = getBrowserTurnMessage({ text: " \n ", parts })

  const preview = latestPreview({ threadIds: [message.threadId], messages: [message] })

  expect(preview).toBe("Cancelado por você")
})

it("keeps canceled previews compact and readable after Markdown formatting", () => {
  const message = getBrowserTurnMessage({ text: `**Resultado parcial**\n${"exemplo ".repeat(20)}` })

  const preview = latestPreview({ threadIds: [message.threadId], messages: [message] })

  expect(preview).toHaveLength(90)
  expect(preview).toMatch(/^Resultado parcial exemplo /)
  expect(preview).toMatch(/…$/)
  expect(preview).not.toContain("**")
})
