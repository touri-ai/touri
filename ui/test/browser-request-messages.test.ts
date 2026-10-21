import type { Message, Run } from "@touri/contracts"
import { expect, test } from "vitest"
import { getBrowserRequestMessages } from "../src/components/browserRequestMessages"

const getMessage = (id: string, runId: string, text: string): Message => ({
  id,
  runId,
  threadId: "channel",
  parentId: "request",
  role: "assistant",
  kind: "text",
  status: "complete",
  text,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 2,
})
const getRun = (id: string, browserRequestId: string): Run => ({
  id,
  browserRequestId,
  threadId: "channel",
  botId: "bot",
  provider: "codex",
  trigger: "retry",
  requestMessageId: "request",
  replyMessageId: null,
  externalTurnId: null,
  status: "succeeded",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: 2,
})
const getBrowserMessage = (id: string, runId: string): Message =>
  Object.assign({}, getMessage(id, runId, "Vou conferir a página."), {
    parts: [
      {
        type: "tool_call" as const,
        callId: id,
        tool: "browser_snapshot",
        summary: "Read",
        inputJson: "{}",
        outputJson: "{}",
        ok: true,
      },
    ],
  })

test("a handback keeps one card and its original row identity with the final answer", () => {
  const first = getBrowserMessage("first", "old")
  const final = getMessage("final", "resumed", "1. Estadia de teste · nota 4,8 · R$ 900")

  const visible = getBrowserRequestMessages([first, final], [getRun("old", "old"), getRun("resumed", "old")])

  expect(visible).toHaveLength(1)
  expect(visible[0]).toMatchObject({ id: "first", runId: "resumed", text: final.text })
  expect(visible[0]?.parts).toEqual(first.parts.concat(final.parts))
  expect(first.parts).toHaveLength(1)
})

test("independent requests and non-browser continuations retain their own messages", () => {
  const first = getBrowserMessage("first", "a")
  const other = getBrowserMessage("other", "b")
  const text = getMessage("text", "c", "Resposta separada")

  const visible = getBrowserRequestMessages(
    [first, other, text],
    [getRun("a", "a"), getRun("b", "b"), getRun("c", "c")],
  )

  expect(visible).toEqual([first, other, text])
})

test("a continuing browser request stays live without changing stored history", () => {
  const first = getBrowserMessage("first", "old")
  const live = Object.assign({}, getBrowserMessage("second", "new"), { status: "streaming" as const })

  const visible = getBrowserRequestMessages([first, live], [getRun("new", "old")])

  expect(visible[0]).toMatchObject({ id: "first", status: "streaming", runId: "new" })
  expect(first.status).toBe("complete")
})

test("browser handback plumbing stays out of the visible conversation", () => {
  const restored = Object.assign({}, getMessage("restored", "old", "Context"), {
    role: "system" as const,
    parts: [{ type: "notice" as const, level: "info" as const, code: "context_restored", text: "Context" }],
  })
  const marker = Object.assign({}, restored, {
    id: "marker",
    parts: [
      {
        type: "notice" as const,
        level: "info" as const,
        code: "run_resumed",
        text: "Retomado após a devolução do navegador",
      },
    ],
  })
  const answer = getMessage("answer", "new", "Resposta final")

  expect(getBrowserRequestMessages([restored, marker, answer], [])).toEqual([answer])
})
