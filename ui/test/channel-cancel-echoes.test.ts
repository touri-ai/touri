import type { Message, Run } from "@touri/contracts"
import { expect, it } from "vitest"
import { getChannelMessages } from "../src/components/channelCancelEchoes"

const getMessage = (patch: Partial<Message> & Pick<Message, "id">): Message => ({
  id: patch.id,
  threadId: patch.threadId ?? "thread-channel",
  parentId: patch.parentId ?? null,
  role: patch.role ?? "assistant",
  kind: patch.kind ?? "text",
  status: patch.status ?? "canceled",
  runId: patch.runId ?? "coordination",
  text: patch.text ?? "",
  parts: patch.parts ?? [],
  sender: patch.sender === undefined ? { id: "bot-mark", name: "mark" } : patch.sender,
  source: "local",
  createdAt: 0,
  updatedAt: 0,
})

const getRun = (patch: Partial<Run> & Pick<Run, "id" | "kind">): Run => ({
  id: patch.id,
  kind: patch.kind,
  groupTurnId: patch.groupTurnId,
  threadId: "thread-channel",
  botId: "bot-mark",
  provider: "codex",
  trigger: "user",
  requestMessageId: patch.requestMessageId ?? "request",
  replyMessageId: null,
  externalTurnId: null,
  status: "canceled",
  errorClass: "canceled",
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 0,
  startedAt: 0,
  finishedAt: 0,
})

const getFixture = (suffix = "") => ({
  request: getMessage({ id: `request${suffix}`, role: "user", status: "complete", text: "@mark espere", sender: null }),
  stopped: getMessage({
    id: `execution${suffix}`,
    runId: `execution${suffix}`,
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
      getCancelNotice(),
    ],
  }),
  echo: getMessage({ id: `coordination${suffix}`, runId: `coordination${suffix}`, parts: [getCancelNotice()] }),
  runs: [
    getRun({ id: `coordination${suffix}`, kind: "coordination", requestMessageId: `request${suffix}` }),
    getRun({
      id: `execution${suffix}`,
      kind: "execution",
      groupTurnId: `coordination${suffix}`,
      requestMessageId: `request${suffix}`,
    }),
  ],
})

const getCancelNotice = () =>
  ({ type: "notice", level: "info", code: "run_canceled", text: "Cancelado por você" }) as const

it("hides the empty cancel echo next to the stopped reply of the same bot", () => {
  const { request, stopped, echo, runs } = getFixture()

  const visible = getChannelMessages([request, stopped, echo], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "execution"])
})

it("hides an echo without a sender that follows the stopped reply", () => {
  const { request, stopped, runs } = getFixture()
  const anonymous = getMessage({ id: "coordination", sender: null, parts: [getCancelNotice()] })

  const visible = getChannelMessages([request, stopped, anonymous], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "execution"])
})

it("keeps a cancel notice when it is the only reply to the request", () => {
  const { request, echo, runs } = getFixture()

  const visible = getChannelMessages([request, echo], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "coordination"])
})

it("keeps another bot's stopped reply", () => {
  const { request, stopped, runs } = getFixture()
  const other = getMessage({ id: "other", sender: { id: "bot-onb", name: "onb" }, parts: [getCancelNotice()] })

  const visible = getChannelMessages([request, stopped, other], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "other"])
})

it("keeps recoverable failures, actions and replies with content", () => {
  const { request, stopped, runs } = getFixture()
  const failure = getMessage({
    id: "failure",
    status: "failed",
    parts: [{ type: "notice", level: "error", code: "run_failed", text: "cli_crash: O provedor encerrou" }],
  })
  const withText = getMessage({ id: "with-text", text: "Parei aqui.", parts: [getCancelNotice()] })
  const withApproval = getMessage({
    id: "with-approval",
    parts: [
      { type: "approval", approvalId: "approval-1", request: "command", detail: "Ação fictícia", decision: "pending" },
      getCancelNotice(),
    ],
  })

  const visible = getChannelMessages([request, stopped, failure, withText, withApproval], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "failure", "with-text", "with-approval"])
})

it("keeps the cancel notice of a different interleaved request", () => {
  const { request, stopped, runs } = getFixture()
  const otherRun = getRun({ id: "other-turn", kind: "coordination", requestMessageId: "other-request" })
  const otherEcho = getMessage({ id: "other-echo", runId: otherRun.id, parts: [getCancelNotice()] })

  const visible = getChannelMessages([request, stopped, otherEcho], runs.concat(otherRun))

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "other-echo"])
})

it("hides the linked echo even after a later user message", () => {
  const { request, stopped, echo, runs } = getFixture()
  const next = getMessage({ id: "next", role: "user", text: "@mark outro pedido" })

  const visible = getChannelMessages([request, stopped, next, echo], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "next"])
})

it("keeps execution notices even when another execution in the same turn has content", () => {
  const { request, stopped, runs } = getFixture()
  const member = getRun({ id: "member", kind: "execution", groupTurnId: "coordination" })
  const notice = getMessage({ id: "member-notice", runId: member.id, parts: [getCancelNotice()] })

  const visible = getChannelMessages([request, stopped, notice], runs.concat(member))

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "member-notice"])
})

it("keeps notices when run identity is unavailable", () => {
  const { request, stopped, echo } = getFixture()

  const visible = getChannelMessages([request, stopped, echo], [])

  expect(visible.map((item) => item.id)).toEqual(["request", "execution", "coordination"])
})

it("keeps the cancel notice when the earlier canceled reply has no content", () => {
  const { request, echo, runs } = getFixture()
  const empty = getMessage({ id: "empty", runId: "execution" })
  const blank = getMessage({ id: "blank", runId: "execution", parts: [{ type: "text", text: "  " }] })

  const visible = getChannelMessages([request, empty, blank, echo], runs)

  expect(visible.map((item) => item.id)).toEqual(["request", "empty", "blank", "coordination"])
})

it("bounds history reads when many requests have been canceled", () => {
  const fixtures = Array.from({ length: 1_000 }, (_, index) => getFixture(String(index)))
  const history = fixtures.flatMap(({ request, stopped, echo }) => [request, stopped, echo])
  const runs = fixtures.flatMap((fixture) => fixture.runs)
  // Count input reads instead of elapsed time so the linear-work guard is independent of CPU load.
  let reads = 0
  const messages = new Proxy(history, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1
      return Reflect.get(target, key, receiver)
    },
  })

  const visible = getChannelMessages(messages, runs)

  expect(visible).toHaveLength(2_000)
  expect(reads).toBeLessThan(history.length * 4)
})
