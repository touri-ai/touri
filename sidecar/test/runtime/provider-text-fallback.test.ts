import { afterEach, expect, test } from "bun:test"
import type { Bot, Kernel, ProviderEvent, StartTurnArgs, Thread } from "@touri/contracts"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()
const engineCleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of engineCleanups) await cleanup()
  engineCleanups.clear()
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getAssistant = (...texts: string[]) => ({
  type: "assistant",
  message: { content: texts.map((text) => ({ type: "text", text })) },
})

const getDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
})

test.each([
  { frames: [getAssistant("Resposta sintética.")], expected: "Resposta sintética." },
  { frames: [getAssistant("Primeiro. ", "Segundo.")], expected: "Primeiro. Segundo." },
  { frames: [getDelta("Olá!"), getAssistant("Olá!")], expected: "Olá!" },
  { frames: [getDelta("Olá"), getAssistant("Olá, mundo!")], expected: "Olá, mundo!" },
  {
    frames: [getDelta("Antes. "), getAssistant("Antes. "), getAssistant("Depois.")],
    expected: "Antes. Depois.",
  },
  { frames: [getAssistant(""), getAssistant("Texto recuperado.")], expected: "Texto recuperado." },
])("preserves complete assistant text without duplicating streamed output: $expected", async (scenario) => {
  const fixture = getFixture(scenario.frames)

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(getText(fixture.events)).toBe(scenario.expected)
  expect(fixture.commandRuns).toHaveLength(1)
})

test("preserves result-only text", async () => {
  const fixture = getFixture([], { type: "result", subtype: "success", result: "Resposta final." })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(getText(fixture.events)).toBe("Resposta final.")
})

test("keeps nested assistant text out of the visible reply", async () => {
  const nested = Object.assign(getAssistant("Relatório interno sintético."), { parent_tool_use_id: "nested-task" })
  const fixture = getFixture([nested, getAssistant("Resposta principal.")])

  await fixture.adapter.startTurn(fixture.args)

  expect(getText(fixture.events)).toBe("Resposta principal.")
})

test("nested assistant frames do not reset the main stream cursor", async () => {
  const nested = Object.assign(getAssistant("Texto interno."), { parent_tool_use_id: "nested-task" })
  const fixture = getFixture([getDelta("Olá"), nested, getAssistant("Olá, mundo!")])

  await fixture.adapter.startTurn(fixture.args)

  expect(getText(fixture.events)).toBe("Olá, mundo!")
})

test.each([{ frames: [] }, { frames: [getDelta(" \n")] }, { frames: [getAssistant(" \t")] }])(
  "rejects an empty successful result instead of completing a blank reply: %j",
  async (scenario) => {
    const fixture = getFixture(scenario.frames)

    const result = await fixture.adapter.startTurn(fixture.args)

    expect(result).toMatchObject({
      success: false,
      errorCode: "cli_protocol",
      error: "O provedor terminou sem responder. Tente de novo.",
    })
    expect(fixture.commandRuns).toHaveLength(2)
    expect(fixture.commandRuns[1]).toContain("--resume")
    expect(getSessionId(fixture.commandRuns[0] ?? [])).toBe(getSessionId(fixture.commandRuns[1] ?? []))
    expect(fixture.events.some((event) => event.type === "turn_completed" && event.status === "succeeded")).toBe(false)
  },
)

test("retries one empty successful response in the same provider session", async () => {
  const fixture = getFixture([], undefined, {
    frames: [getAssistant("Resposta recuperada.")],
    result: { type: "result", subtype: "success", is_error: false, result: "" },
  })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(getText(fixture.events)).toBe("Resposta recuperada.")
  expect(fixture.commandRuns).toHaveLength(2)
  expect(fixture.commandRuns[0]).toContain("--session-id")
  expect(fixture.commandRuns[1]).toContain("--resume")
  expect(getSessionId(fixture.commandRuns[0] ?? [])).toBe(getSessionId(fixture.commandRuns[1] ?? []))
  expect(fixture.events.filter((event) => event.type === "turn_completed")).toEqual([
    expect.objectContaining({ status: "succeeded" }),
  ])
})

test("resumes an existing native session for both attempts", async () => {
  const fixture = getFixture([], undefined, {
    frames: [getAssistant("Resposta recuperada.")],
    result: { type: "result", subtype: "success", result: "" },
  })
  const session = { externalSessionId: "synthetic-existing-session", rolloutPath: null } as NonNullable<
    StartTurnArgs["session"]
  >

  const result = await fixture.adapter.startTurn(Object.assign({}, fixture.args, { session }))

  expect(result).toMatchObject({ success: true, externalSessionId: session.externalSessionId })
  expect(fixture.commandRuns).toHaveLength(2)
  expect(fixture.commandRuns.every((args) => args.includes("--resume"))).toBe(true)
  expect(fixture.commandRuns.map(getSessionId)).toEqual([session.externalSessionId, session.externalSessionId])
})

test("preserves a resume diagnostic when the empty attempt's session cannot be loaded", async () => {
  const diagnostic = "No conversation found with session ID: synthetic-missing-session"
  const fixture = getFixture([], undefined, { frames: [], result: null, stderr: diagnostic })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toEqual({ success: false, errorCode: "cli_protocol", error: diagnostic })
  expect(fixture.commandRuns).toHaveLength(2)
})

test("does not retry an empty result after cancellation", async () => {
  const fixture = getFixture([])
  const controller = new AbortController()
  const onEvent = (event: ProviderEvent) => {
    fixture.args.onEvent(event)
    if (event.type === "session") controller.abort()
  }

  const result = await fixture.adapter.startTurn(
    Object.assign({}, fixture.args, { signal: controller.signal, onEvent }),
  )

  expect(result).not.toMatchObject({ success: true, status: "succeeded" })
  expect(fixture.commandRuns).toHaveLength(1)
})

test("does not retry a turn that requested approval", async () => {
  const fixture = getFixture([
    { type: "approval_request", approval_id: "synthetic-approval", tool_name: "Bash", input: { command: "pwd" } },
  ])

  await fixture.adapter.startTurn(fixture.args)

  expect(fixture.commandRuns).toHaveLength(1)
  expect(fixture.events.some((event) => event.type === "approval_request")).toBe(true)
})

test("keeps a tool-only result eligible for the runtime action conclusion", async () => {
  const fixture = getFixture([
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "notes.txt" } }] },
    },
  ])

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(fixture.commandRuns).toHaveLength(1)
  expect(fixture.events.some((event) => event.type === "item" && event.part.type === "tool_call")).toBe(true)
})

test("keeps an explicit provider error failed", async () => {
  const fixture = getFixture([], { type: "result", is_error: true, result: "Synthetic provider failure" })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "failed" })
  expect(getText(fixture.events)).toBe("")
  expect(fixture.commandRuns).toHaveLength(1)
})

test.each([
  {
    frames: [getAssistant("Resposta preservada.")],
    secondAttempt: undefined,
    status: "succeeded",
    replyStatus: "complete",
    attempts: 1,
  },
  {
    frames: [],
    secondAttempt: {
      frames: [getAssistant("Resposta preservada.")],
      result: { type: "result", subtype: "success", result: "" },
    },
    status: "succeeded",
    replyStatus: "complete",
    attempts: 2,
  },
  { frames: [], secondAttempt: undefined, status: "failed", replyStatus: "failed", attempts: 2 },
])("persists a visible reply with run status $status", async (scenario) => {
  const fixture = getFixture(scenario.frames, undefined, scenario.secondAttempt)
  await initStore(fixture.kernel)
  fixture.fixture.db
    .query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Teste','claude',?,1,1)")
    .run(fixture.kernel.paths.appData)
  fixture.fixture.db.exec(
    "INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('synthetic-thread','bot','Conversa',1,1)",
  )
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const request = store.insertMessage({
    message: {
      id: "request",
      threadId: "synthetic-thread",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Responda à mensagem sintética.",
      parts: [{ type: "text", text: "Responda à mensagem sintética." }],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const engine = createRuntimeEngine({
    kernel: fixture.kernel,
    providerAdapters: { claude: fixture.adapter },
    environment: { PATH: "/usr/bin", HOME: fixture.kernel.paths.appData },
  })
  engineCleanups.add(() => engine.shutdown())

  const queued = engine.enqueue({ threadId: "synthetic-thread", requestMessageId: "request", trigger: "user" })
  if (!queued.success) throw new Error(queued.error)
  const deadline = Date.now() + 5_000
  while (["queued", "starting", "running"].includes(queued.run.status)) {
    if (Date.now() > deadline) throw new Error("Turn did not finish")
    await Bun.sleep(5)
  }

  const reply = store.activePath({ threadId: "synthetic-thread" }).find((message) => message.role === "assistant")
  expect(queued.run.status).toBe(scenario.status)
  expect(reply?.status).toBe(scenario.replyStatus)
  expect(reply?.parts.length).toBeGreaterThan(0)
  expect(fixture.commandRuns).toHaveLength(scenario.attempts)
  if (scenario.status === "succeeded") expect(reply?.text).toBe("Resposta preservada.")
  if (scenario.status === "failed")
    expect(reply?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "run_failed" }))
})

const getText = (events: ReadonlyArray<ProviderEvent>) =>
  events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("")

const getSessionId = (args: ReadonlyArray<string>): string | undefined => {
  const flag = args.includes("--resume") ? "--resume" : "--session-id"
  return args[args.indexOf(flag) + 1]
}

type ProviderScenario = { frames: ReadonlyArray<object>; result: object | null; stderr?: string }

const getFixture = (
  frames: ReadonlyArray<object>,
  result: object = { type: "result", subtype: "success", is_error: false, result: "" },
  secondAttempt?: ProviderScenario,
) => {
  const fixture = testKernel()
  // This recorder belongs to one synthetic provider lifecycle.
  let commandRuns: ReadonlyArray<ReadonlyArray<string>> = []
  const spawn: Kernel["spawnTree"] = ({ args: commandArgs }) => {
    const attempt: ProviderScenario =
      commandRuns.length === 0 ? { frames, result } : (secondAttempt ?? { frames, result })
    const sessionFlag = commandArgs.find((argument) => argument === "--session-id" || argument === "--resume")
    const externalSessionId = sessionFlag ? commandArgs[commandArgs.indexOf(sessionFlag) + 1] : "synthetic-session"
    commandRuns = commandRuns.concat([commandArgs])

    // Stream controllers and process completion belong to this synthetic child only.
    let output: ReadableStreamDefaultController<Uint8Array>
    let finish: (value: { code: number; signal: null }) => void = () => undefined
    let closed = false
    return {
      success: true,
      target: "remote",
      pid: 0,
      pgid: 0,
      extra: [],
      stdout: new ReadableStream({ start: (controller) => (output = controller) }),
      stderr: new ReadableStream({
        start: (controller) => {
          if (attempt.stderr) controller.enqueue(new TextEncoder().encode(attempt.stderr))
          controller.close()
        },
      }),
      stdin: new WritableStream({
        write: () => {
          const wireFrames = Array.of<object>({
            type: "system",
            subtype: "init",
            session_id: externalSessionId,
          }).concat(attempt.frames, attempt.result ? [attempt.result] : [])
          const wireText = wireFrames.map((frame) => JSON.stringify(frame)).join("\n")
          output.enqueue(new TextEncoder().encode(`${wireText}\n`))
          if (attempt.result === null) {
            closed = true
            output.close()
            finish({ code: 1, signal: null })
          }
        },
      }),
      exited: new Promise((resolve) => (finish = resolve)),
      kill: () => {
        if (closed) return
        closed = true
        output.close()
        finish({ code: 0, signal: null })
      },
    }
  }
  const kernel = Object.assign({}, fixture.kernel, { spawnTree: spawn })
  const adapter = createClaudeAdapter({ kernel, command: process.execPath })
  cleanups.add(async () => {
    await adapter.shutdown()
    fixture.close()
  })
  const events: ProviderEvent[] = []
  const args: StartTurnArgs = {
    bot: { provider: "claude", access: "full", approvals: "never", homeDir: kernel.paths.appData } as Bot,
    thread: { id: "synthetic-thread" } as Thread,
    session: null,
    fingerprint: { cwd: kernel.paths.appData } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Responda à mensagem sintética." }],
    developerInstructions: "Synthetic response preservation test.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: { HOME: kernel.paths.appData },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  }

  return {
    fixture,
    kernel,
    adapter,
    args,
    events,
    get commandRuns() {
      return commandRuns
    },
  }
}
