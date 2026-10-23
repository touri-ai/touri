import type { Message } from "@touri/contracts"
import { expect, it } from "vitest"
import { getChannelMessages } from "../src/components/channelCancelEchoes"

const message = (patch: Partial<Message> & Pick<Message, "id">): Message =>
  ({
    threadId: "thread-channel",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "complete",
    runId: null,
    text: "",
    parts: [],
    sender: { id: "bot-mark", name: "mark" },
    source: "local",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }) as Message

const request = message({ id: "request", role: "user", text: "@mark espere", sender: null })
const cancelNotice = { type: "notice", level: "info", code: "run_canceled", text: "Cancelado por você" } as const
const stopped = message({
  id: "execution",
  status: "canceled",
  text: "Teste de parar iniciado",
  parts: [
    { type: "text", text: "Teste de parar iniciado" },
    {
      type: "command",
      callId: "call-wait",
      command: "python3 espera.py",
      cwd: "/demo",
      exitCode: null,
      outputTail: "",
    },
    cancelNotice,
  ],
})
const echo = message({ id: "coordination", status: "canceled", parts: [cancelNotice] })

it("hides the empty cancel echo next to the stopped reply of the same bot", () => {
  expect(getChannelMessages([request, stopped, echo]).map((item) => item.id)).toEqual(["request", "execution"])
})

it("hides an echo without a sender that follows the stopped reply", () => {
  const anonymous = { ...echo, sender: null }

  expect(getChannelMessages([request, stopped, anonymous]).map((item) => item.id)).toEqual(["request", "execution"])
})

it("keeps a cancel notice when it is the only reply to the request", () => {
  expect(getChannelMessages([request, echo]).map((item) => item.id)).toEqual(["request", "coordination"])
})

it("keeps another bot's stopped reply", () => {
  const other = { ...echo, sender: { id: "bot-onb", name: "onb" } }

  expect(getChannelMessages([request, stopped, other]).map((item) => item.id)).toEqual([
    "request",
    "execution",
    "coordination",
  ])
})

it("keeps recoverable failures and replies with content", () => {
  const failure = message({
    id: "failure",
    status: "failed",
    parts: [{ type: "notice", level: "error", code: "run_failed", text: "cli_crash: O provedor encerrou" }],
  })
  const withText = {
    ...echo,
    id: "with-text",
    text: "Parei aqui.",
    parts: [{ type: "text", text: "Parei aqui." }, cancelNotice],
  }

  expect(getChannelMessages([request, stopped, failure, withText]).map((item) => item.id)).toEqual([
    "request",
    "execution",
    "failure",
    "with-text",
  ])
})

it("keeps the cancel notice of a later request", () => {
  const next = { ...request, id: "next" }

  expect(getChannelMessages([request, stopped, next, echo]).map((item) => item.id)).toEqual([
    "request",
    "execution",
    "next",
    "coordination",
  ])
})
