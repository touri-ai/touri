import type { Message, ToolCallPart } from "@touri/contracts"
import { expect, test } from "vitest"
import { getBrowserRequestMessages } from "../src/features/channelBrowser/browserRequestMessages"

const getMessage = (id: string, requestId = "request", botId = "leo"): Message => {
  const tool: ToolCallPart = {
    type: "tool_call",
    callId: id,
    tool: "mcp__touri__browser_snapshot",
    inputJson: "{}",
    summary: "Read",
    outputJson: null,
    ok: true,
    browserRequestId: requestId,
  }

  return {
    id,
    threadId: "channel",
    parentId: "prompt",
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: id,
    text: id,
    parts: [tool, { type: "text", text: id }],
    sender: { id: botId, name: botId },
    source: "local",
    createdAt: 1,
    updatedAt: 1,
  }
}

test("cold history restores one browser receipt with the continuation and final answer", () => {
  const messages = [getMessage("original"), getMessage("resumed")]
  const history = JSON.parse(JSON.stringify(messages)) as Message[]

  const visible = getBrowserRequestMessages(history)

  expect(visible).toHaveLength(1)
  expect(visible[0]).toMatchObject({ id: "original", runId: "resumed", text: "original\n\nresumed" })
  expect(visible[0]?.parts.filter((part) => part.type === "tool_call")).toHaveLength(2)
  expect(history).toEqual(messages)
})

test("different requests, bot identities and user messages remain separate", () => {
  const user = Object.assign({}, getMessage("user"), {
    role: "user" as const,
    parts: [{ type: "text" as const, text: "Follow-up" }],
  })
  const messages = [
    getMessage("first"),
    getMessage("other-request", "different"),
    getMessage("other-bot", "request", "bia"),
    user,
    getMessage("last"),
  ]

  const visible = getBrowserRequestMessages(messages)

  expect(visible.map((message) => message.id)).toEqual(["first", "other-request", "other-bot", "user"])
  expect(visible[0]?.text).toBe("first\n\nlast")
})
