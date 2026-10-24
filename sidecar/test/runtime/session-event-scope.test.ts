import { afterEach, expect, test } from "bun:test"
import type { Bot, Kernel, ProviderEvent, StartTurnArgs, Thread } from "@touri/contracts"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { testKernel } from "../kernel/test-kernel"

type Frame = Record<string, unknown>
const fixtures = new Set<ReturnType<typeof makeFixture>>()
afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.adapter.shutdown()
    fixture.kernel.close()
  }
  fixtures.clear()
})

test.each([0, 17])("process exit %s drains acknowledged buffered frames before settling", async (code) => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  const request = await fixture.nextRequest("turn/start")
  Array.from({ length: 20 }, () =>
    fixture.send({
      method: "item/agentMessage/delta",
      params: { threadId: "parent", turnId: "current", itemId: "reply", delta: "saved " },
    }),
  )
  fixture.acknowledge(request)
  if (code === 0)
    fixture.send({
      method: "turn/completed",
      params: { threadId: "parent", turnId: "current", status: "succeeded" },
    })
  fixture.exit(code)

  const result = await running

  expect(
    fixture.events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
  ).toBe("saved ".repeat(20))
  expect(result.success).toBe(code === 0)
  if (!result.success) expect(result.errorCode).toBe("cli_crash")
})

test.each(["before acknowledgement", "after acknowledgement"])(
  "isolates foreign and stale events %s",
  async (phase) => {
    const fixture = makeFixture()
    const running = fixture.adapter.startTurn(fixture.args)
    const request = await fixture.nextRequest("turn/start")
    if (phase === "after acknowledgement") fixture.acknowledge(request)

    getForeignScopes().flatMap(getForeignFrames).forEach(fixture.send)
    if (phase === "before acknowledgement") fixture.acknowledge(request)
    fixture.send({ method: "turn/started", params: { threadId: "parent", turn: { id: "current" } } })
    fixture.send({
      method: "item/agentMessage/delta",
      params: { threadId: "parent", turnId: "current", delta: "proper output" },
    })
    await fixture.nextText()
    await fixture.nextRequest(undefined, "foreign-input")

    expect(fixture.events).toEqual([
      { type: "session", externalSessionId: "parent", rolloutPath: null },
      { type: "turn_started", externalTurnId: "current" },
      { type: "text_delta", itemId: "agent", delta: "proper output" },
    ])
    expect(fixture.requests.filter((frame) => frame.id === "foreign-command").at(-1)).toMatchObject({
      result: { decision: "decline" },
    })
    expect(fixture.requests.filter((frame) => frame.id === "foreign-file").at(-1)).toMatchObject({
      result: { decision: "decline" },
    })
    expect(fixture.requests.filter((frame) => frame.id === "foreign-permission").at(-1)).toMatchObject({
      result: { permissions: {}, scope: "turn" },
    })
    expect(fixture.requests.filter((frame) => frame.id === "foreign-form").at(-1)).toMatchObject({
      result: { action: "decline" },
    })
    expect(fixture.requests.filter((frame) => frame.id === "foreign-input").at(-1)).toMatchObject({
      error: { code: -32601 },
    })

    fixture.send({
      method: "turn/completed",
      params: { threadId: "parent", turn: { id: "current", status: "completed" } },
    })

    expect(await running).toMatchObject({ success: true, status: "succeeded", externalSessionId: "parent" })
    expect(fixture.events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
  },
)

test("Stop uses the acknowledged parent turn despite earlier auxiliary and stale starts", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  const request = await fixture.nextRequest("turn/start")
  fixture.send({ method: "turn/started", params: { threadId: "auxiliary", turn: { id: "auxiliary-turn" } } })
  fixture.send({ method: "turn/started", params: { threadId: "parent", turn: { id: "previous" } } })
  fixture.controller.abort()
  fixture.acknowledge(request)

  const interrupt = await fixture.nextRequest("turn/interrupt")

  expect(interrupt.params).toEqual({ threadId: "parent", turnId: "current" })
  fixture.send({
    method: "turn/completed",
    params: { threadId: "parent", turn: { id: "current", status: "interrupted" } },
  })
  expect(await running).toMatchObject({ success: true, status: "interrupted" })
})

test("preserves unscoped legacy notifications and parent approval routing", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  fixture.acknowledge(await fixture.nextRequest("turn/start"))
  fixture.send({ method: "turn/started", params: { turnId: "current" } })
  fixture.send({ id: 90, method: "item/commandExecution/requestApproval", params: { command: "pwd" } })
  fixture.send({ method: "item/agentMessage/delta", params: { delta: "legacy output" } })
  await fixture.nextText()
  const approval = fixture.events.find((event) => event.type === "approval_request")
  if (approval?.type !== "approval_request") throw new Error("Missing parent approval")

  expect(await fixture.adapter.answerApproval({ approvalId: approval.approvalId, decision: "denied" })).toEqual({
    success: true,
  })
  expect(await fixture.nextRequest(undefined, 90)).toMatchObject({ result: { decision: "decline" } })
  fixture.send({ method: "turn/completed", params: { status: "succeeded" } })

  expect(await running).toMatchObject({ success: true, status: "succeeded" })
})

test.each(["error", "transport/fatal"])("preserves unscoped global %s", async (method) => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  await fixture.nextRequest("thread/resume")

  fixture.send({ method, params: { message: "Synthetic transport failure" } })

  expect(await running).toMatchObject({ success: false, error: "Synthetic transport failure" })
})

test("preserves matching session setup errors before turn submission", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  await fixture.nextRequest("thread/resume")

  fixture.send({ method: "error", params: { threadId: "auxiliary", message: "Foreign setup failure" } })
  fixture.send({ method: "error", params: { threadId: "parent", message: "Synthetic session setup failure" } })

  expect(await running).toMatchObject({ success: false, error: "Synthetic session setup failure" })
})

test("rejects an excessive pre-acknowledgement backlog", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  await fixture.nextRequest("turn/start")

  Array.from({ length: 129 }, () => ({
    method: "item/agentMessage/delta",
    params: { threadId: "parent", turnId: "current", delta: "pending" },
  })).forEach(fixture.send)

  expect(await running).toMatchObject({ success: false, errorCode: "cli_protocol" })
  expect(fixture.events.some((event) => event.type === "text_delta")).toBe(false)
})

test("reuses a warm parent session without accepting its previous turn", async () => {
  const fixture = makeFixture()
  const { execution: _execution, ...localArgs } = fixture.args
  const args = { ...localArgs, conversationOnly: true }
  const first = fixture.adapter.startTurn(args)
  fixture.acknowledge(await fixture.nextRequest("turn/start"))
  fixture.send({
    method: "turn/completed",
    params: { threadId: "parent", turn: { id: "current", status: "completed" } },
  })
  expect(await first).toMatchObject({ success: true, status: "succeeded" })
  const previousRequests = fixture.requests.length
  const second = fixture.adapter.startTurn(args)
  const request = await fixture.nextRequest("turn/start", undefined, previousRequests)

  fixture.send({ method: "turn/started", params: { threadId: "parent", turn: { id: "current" } } })
  fixture.send({
    method: "item/agentMessage/delta",
    params: { threadId: "parent", turnId: "current", delta: "stale output" },
  })
  fixture.send({
    method: "turn/completed",
    params: { threadId: "parent", turn: { id: "current", status: "completed" } },
  })
  fixture.send({ id: request.id, result: { turn: { id: "next" } } })
  fixture.send({
    method: "item/agentMessage/delta",
    params: { threadId: "parent", turnId: "next", delta: "fresh output" },
  })
  await fixture.nextText()

  expect(fixture.requests.filter((frame) => frame.method === "initialize")).toHaveLength(1)
  expect(fixture.requests.filter((frame) => frame.method === "thread/resume")).toHaveLength(1)
  expect(fixture.events.filter((event) => event.type === "text_delta")).toEqual([
    { type: "text_delta", itemId: "agent", delta: "fresh output" },
  ])
  expect(fixture.events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
  fixture.send({ method: "turn/completed", params: { threadId: "parent", turn: { id: "next", status: "completed" } } })
  expect(await second).toMatchObject({ success: true, status: "succeeded" })
})

test("replays only parent events received before the turn acknowledgement", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  const request = await fixture.nextRequest("turn/start")
  const scope = { threadId: "parent", turnId: "current" }

  fixture.send({ method: "turn/started", params: { threadId: "parent", turn: { id: "current" } } })
  fixture.send({ method: "item/reasoning/summaryTextDelta", params: { ...scope, delta: "parent reasoning" } })
  fixture.send({
    method: "item/started",
    params: { ...scope, item: { type: "commandExecution", id: "shell", command: "pwd" } },
  })
  fixture.send({ method: "item/commandExecution/outputDelta", params: { ...scope, itemId: "shell", delta: "ok" } })
  fixture.send({
    id: "parent-approval",
    method: "item/commandExecution/requestApproval",
    params: { ...scope, command: "pwd", arguments: { threadId: "auxiliary", turnId: "previous" } },
  })
  fixture.send({ method: "item/agentMessage/delta", params: { ...scope, delta: "parent output" } })
  fixture.send({ method: "turn/completed", params: { ...scope, status: "completed" } })
  fixture.acknowledge(request)

  expect(await running).toMatchObject({ success: true, status: "succeeded" })
  expect(fixture.events.some((event) => event.type === "reasoning_delta" && event.delta === "parent reasoning")).toBe(
    true,
  )
  expect(
    fixture.events.some(
      (event) => event.type === "item" && event.part.type === "command" && event.part.outputTail === "ok",
    ),
  ).toBe(true)
  expect(fixture.events.some((event) => event.type === "approval_request" && event.part.decision === "pending")).toBe(
    true,
  )
  expect(fixture.events.filter((event) => event.type === "text_delta")).toEqual([
    { type: "text_delta", itemId: "agent", delta: "parent output" },
  ])
})

test("Stop keeps the parent identity after acknowledgement and foreign starts", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  fixture.acknowledge(await fixture.nextRequest("turn/start"))
  fixture.send({
    method: "item/agentMessage/delta",
    params: { threadId: "parent", turnId: "current", delta: "active" },
  })
  await fixture.nextText()
  fixture.send({ method: "turn/started", params: { threadId: "auxiliary", turn: { id: "child" } } })
  fixture.send({ method: "turn/started", params: { threadId: "parent", turn: { id: "previous" } } })

  fixture.controller.abort()

  expect((await fixture.nextRequest("turn/interrupt")).params).toEqual({ threadId: "parent", turnId: "current" })
  fixture.send({ method: "turn/completed", params: { threadId: "parent", turnId: "current", status: "interrupted" } })
  expect(await running).toMatchObject({ success: true, status: "interrupted" })
})

test("bounds pre-acknowledgement retained payload as well as event count", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  await fixture.nextRequest("turn/start")

  fixture.send({
    method: "item/agentMessage/delta",
    params: { threadId: "parent", turnId: "current", delta: "x".repeat(524_288) },
  })

  expect(await running).toMatchObject({ success: false, errorCode: "cli_protocol" })
  expect(fixture.events.some((event) => event.type === "text_delta")).toBe(false)
})

test("acknowledgement replay yields to cancellation and preserves new frame order", async () => {
  const fixture = makeFixture()
  const checkpoint = Promise.withResolvers<number>()
  const args = {
    ...fixture.args,
    onEvent: (event: ProviderEvent) => {
      fixture.args.onEvent(event)
      if (event.type !== "text_delta" || event.delta !== "0") return

      setImmediate(() => {
        checkpoint.resolve(fixture.events.filter((entry) => entry.type === "text_delta").length)
        fixture.controller.abort()
        fixture.send({
          method: "item/agentMessage/delta",
          params: { threadId: "parent", turnId: "current", delta: "last" },
        })
        fixture.send({ method: "turn/completed", params: { turnId: "current", status: "interrupted" } })
      })
    },
  }
  const running = fixture.adapter.startTurn(args)
  const request = await fixture.nextRequest("turn/start")
  const deltas = Array.from({ length: 64 }, (_, index) => String(index))
  deltas.forEach((delta) => {
    fixture.send({
      method: "item/agentMessage/delta",
      params: { threadId: "parent", turnId: "current", delta },
    })
  })
  fixture.send({ id: "buffer-barrier", method: "item/tool/requestUserInput", params: { threadId: "auxiliary" } })
  await fixture.nextRequest(undefined, "buffer-barrier")

  fixture.acknowledge(request)

  expect(await checkpoint.promise).toBeLessThan(deltas.length)
  expect((await fixture.nextRequest("turn/interrupt")).params).toEqual({ threadId: "parent", turnId: "current" })
  expect(await running).toMatchObject({ success: true, status: "interrupted" })
  expect(fixture.events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
    ...deltas,
    "last",
  ])
})

test("a scoped parent error still fails its own turn", async () => {
  const fixture = makeFixture()
  const running = fixture.adapter.startTurn(fixture.args)
  fixture.acknowledge(await fixture.nextRequest("turn/start"))

  fixture.send({
    method: "error",
    params: { threadId: "parent", turnId: "current", message: "Synthetic parent failure" },
  })

  expect(await running).toMatchObject({ success: false, error: "Synthetic parent failure" })
})

const getForeignScopes = () => [
  { threadId: "auxiliary", turnId: "auxiliary-turn" },
  { threadId: "parent", turnId: "previous" },
  { threadId: "parent", turnId: "current", item: { threadId: "auxiliary" } },
  { threadId: "parent", turnId: "current", turn: { id: "previous" } },
  { thread: { id: "auxiliary" }, turn: { id: "current" } },
  { item: { turn: { id: "previous", threadId: "parent" } } },
  { error: { threadId: "auxiliary", turnId: "current" } },
  { threadId: "parent", turn: { id: "current", error: { threadId: "auxiliary" } } },
  { item: { error: { turnId: "previous" } } },
  { thread_id: "auxiliary", turn_id: "current" },
]

const getForeignFrames = (scope: Frame): Frame[] => [
  { method: "turn/started", params: scope },
  { method: "item/agentMessage/delta", params: { delta: "foreign text", ...scope } },
  { method: "item/reasoning/summaryTextDelta", params: { delta: "foreign reasoning", ...scope } },
  { method: "item/started", params: { item: { type: "commandExecution", id: "shell", command: "pwd" }, ...scope } },
  { method: "item/commandExecution/outputDelta", params: { itemId: "shell", delta: "foreign output", ...scope } },
  { method: "item/completed", params: { item: { type: "agentMessage", text: "foreign final" }, ...scope } },
  { method: "turn/usage", params: { inputTokens: 99, ...scope } },
  { id: "foreign-command", method: "item/commandExecution/requestApproval", params: scope },
  { id: "foreign-file", method: "item/fileChange/requestApproval", params: scope },
  { id: "foreign-permission", method: "item/permissions/requestApproval", params: scope },
  { id: "foreign-form", method: "mcpServer/elicitation/request", params: scope },
  { id: "foreign-input", method: "item/tool/requestUserInput", params: scope },
  { method: "error", params: { message: "foreign error", ...scope } },
  { method: "transport/fatal", params: { message: "foreign fatal", ...scope } },
  { method: "turn/completed", params: { status: "succeeded", ...scope } },
]

const makeFixture = () => {
  const kernel = testKernel()
  const events: ProviderEvent[] = []
  const requests: Frame[] = []
  const waiters = new Set<() => void>()
  const controller = new AbortController()
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let finish: (value: { code: number; signal: null }) => void = () => undefined
  const send = (frame: Frame) => output?.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
  const spawn: Kernel["spawnTree"] = () => ({
    success: true,
    target: "remote",
    pid: 0,
    pgid: 0,
    extra: [],
    stdout: new ReadableStream({
      start: (stream) => {
        output = stream
      },
    }),
    stderr: new ReadableStream({ start: (stream) => stream.close() }),
    exited: new Promise((resolve) => {
      finish = resolve
    }),
    kill: () => {
      output?.close()
      output = undefined
      finish({ code: 0, signal: null })
    },
    stdin: new WritableStream({
      write: (chunk) => {
        const request = JSON.parse(new TextDecoder().decode(chunk)) as Frame
        requests.push(request)
        if (request.method === "initialize" || request.method === "thread/resume")
          send({ id: request.id, result: { thread: { id: "parent" } } })
        waiters.forEach((notify) => {
          notify()
        })
      },
    }),
  })
  const adapter = createCodexAdapter({ kernel: { ...kernel.kernel, spawnTree: spawn }, command: process.execPath })
  const args: StartTurnArgs = {
    bot: {
      provider: "codex",
      access: "full",
      approvals: "on-request",
      homeDir: kernel.kernel.paths.appData,
      model: null,
    } as Bot,
    thread: { id: "parent-thread" } as Thread,
    session: { externalSessionId: "parent", rolloutPath: null } as StartTurnArgs["session"],
    fingerprint: { cwd: kernel.kernel.paths.appData } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Synthetic lifecycle test" }],
    developerInstructions: "Synthetic lifecycle test",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    execution: { spawn, writeFile: async () => undefined },
    env: {},
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      waiters.forEach((notify) => {
        notify()
      })
    },
  }
  const nextValue = <T>(getValue: () => T | undefined): Promise<T> =>
    new Promise((resolve) => {
      const notify = () => {
        const value = getValue()
        if (value === undefined) return
        waiters.delete(notify)
        resolve(value)
      }
      waiters.add(notify)
      notify()
    })
  const fixture = {
    kernel,
    adapter,
    args,
    controller,
    events,
    requests,
    send,
    exit: (code: number) => {
      output?.close()
      output = undefined
      finish({ code, signal: null })
    },
    acknowledge: (request: Frame) => send({ id: request.id, result: { turn: { id: "current" } } }),
    nextRequest: (method?: string, id?: string | number, offset = 0) =>
      nextValue(() =>
        requests.slice(offset).find((frame) => frame.method === method && (id === undefined || frame.id === id)),
      ),
    nextText: () => nextValue(() => events.find((event) => event.type === "text_delta")),
  }
  fixtures.add(fixture)

  return fixture
}
