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
})

test("preserves result-only text", async () => {
  const fixture = getFixture([], { type: "result", subtype: "success", result: "Resposta final." })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(getText(fixture.events)).toBe("Resposta final.")
})

test.each([{ frames: [] }, { frames: [getDelta(" \n")] }, { frames: [getAssistant(" \t")] }])(
  "rejects an empty successful result instead of completing a blank reply: %j",
  async (scenario) => {
    const fixture = getFixture(scenario.frames)

    const result = await fixture.adapter.startTurn(fixture.args)

    expect(result).toMatchObject({ success: false, errorCode: "cli_protocol" })
    expect(fixture.events.some((event) => event.type === "turn_completed" && event.status === "succeeded")).toBe(false)
  },
)

test("keeps a tool-only result eligible for the runtime action conclusion", async () => {
  const fixture = getFixture([
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "notes.txt" } }] },
    },
  ])

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "succeeded" })
  expect(fixture.events.some((event) => event.type === "item" && event.part.type === "tool_call")).toBe(true)
})

test("keeps an explicit provider error failed", async () => {
  const fixture = getFixture([], { type: "result", is_error: true, result: "Synthetic provider failure" })

  const result = await fixture.adapter.startTurn(fixture.args)

  expect(result).toMatchObject({ success: true, status: "failed" })
  expect(getText(fixture.events)).toBe("")
})

test.each([
  { frames: [getAssistant("Resposta preservada.")], status: "succeeded", replyStatus: "complete" },
  { frames: [], status: "failed", replyStatus: "failed" },
])("persists a visible reply with run status $status", async (scenario) => {
  const fixture = getFixture(scenario.frames)
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
  if (scenario.status === "succeeded") expect(reply?.text).toBe("Resposta preservada.")
  if (scenario.status === "failed")
    expect(reply?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "run_failed" }))
})

const getText = (events: ReadonlyArray<ProviderEvent>) =>
  events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("")

const getFixture = (
  frames: ReadonlyArray<object>,
  result: object = { type: "result", subtype: "success", is_error: false, result: "" },
) => {
  const fixture = testKernel()
  const spawn: Kernel["spawnTree"] = () => {
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
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      stdin: new WritableStream({
        write: () => {
          const wireFrames = Array.of<object>({
            type: "system",
            subtype: "init",
            session_id: "synthetic-session",
          }).concat(frames, result)
          const wireText = wireFrames.map((frame) => JSON.stringify(frame)).join("\n")
          output.enqueue(new TextEncoder().encode(`${wireText}\n`))
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

  return { fixture, kernel, adapter, args, events }
}
