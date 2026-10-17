import { expect, test } from "bun:test"
import type { Bot, Kernel, ProviderEvent, StartTurnArgs, Thread } from "@touri/contracts"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"

const scenarios = ["claude", "claude-progress", "codex", "codex-resume"] as const

test.each(scenarios)("%s emits reasoning before the turn completes", async (scenario) => {
  const provider = scenario.startsWith("claude") ? "claude" : "codex"
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      output = controller
    },
  })
  const send = (frame: unknown) => output?.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
  let finish: () => void = () => undefined
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    finish = () => {
      output?.close()
      output = undefined
      resolve({ code: 0, signal: null })
    }
  })
  const empty = () => new Response("").body as ReadableStream<Uint8Array>
  const frames =
    scenario === "claude-progress"
      ? [
          { type: "system", subtype: "init", session_id: "test-session" },
          {
            type: "stream_event",
            event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          },
          ...[120, 230, -1, "invalid", null].map((estimated_tokens) => ({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "", signature: "opaque-signature", estimated_tokens },
            },
          })),
          {
            type: "assistant",
            message: { content: [{ type: "thinking", thinking: "", signature: "opaque-signature" }] },
          },
          {
            type: "stream_event",
            event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50 },
            },
          },
          {
            type: "stream_event",
            event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Pronto." } },
          },
        ]
      : provider === "claude"
        ? [
            { type: "system", subtype: "init", session_id: "test-session" },
            {
              type: "stream_event",
              event: {
                type: "content_block_start",
                index: 0,
                content_block: { type: "thinking", thinking: "Conferindo " },
              },
            },
            {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: "a fila." },
              },
            },
            {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "signature_delta", signature: "opaque-signature" },
              },
            },
            {
              type: "assistant",
              message: {
                content: [{ type: "thinking", thinking: "Conferindo a fila.", signature: "opaque-signature" }],
              },
            },
            { type: "assistant", message: { content: [{ type: "thinking", thinking: "Verificando o lock." }] } },
            {
              type: "stream_event",
              event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Pronto." } },
            },
          ]
        : [
            { method: "turn/started", params: { turnId: "test-turn" } },
            { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", delta: "Conferindo " } },
            { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", delta: "a fila." } },
            { method: "item/agentMessage/delta", params: { itemId: "reply", delta: "Pronto." } },
          ]
  const spawn: Kernel["spawnTree"] = ({ cmd }) => {
    if (cmd === "cat")
      return {
        success: true,
        pid: 0,
        pgid: 0,
        stdout: new Response("{}").body as ReadableStream<Uint8Array>,
        stderr: empty(),
        stdin: new WritableStream(),
        extra: [],
        exited: Promise.resolve({ code: 0, signal: null }),
        kill: () => undefined,
      }
    return {
      success: true,
      pid: 0,
      pgid: 0,
      stdout,
      stderr: empty(),
      extra: [],
      exited,
      kill: finish,
      stdin: new WritableStream({
        write: (chunk) => {
          const request = JSON.parse(new TextDecoder().decode(chunk))
          requests.push(request)
          if (request.id !== undefined)
            send({ id: request.id, result: { thread: { id: "test-session" }, turn: { id: "test-turn" } } })
          if (request.type === "user" || request.method === "turn/start") for (const frame of frames) send(frame)
        },
      }),
    }
  }
  const kernel = {
    paths: { appData: "/test", runDir: "/test/run" },
    services: { use: () => null },
    redact: (text: string) => text,
  } as unknown as Kernel
  const adapter = provider === "claude" ? createClaudeAdapter({ kernel }) : createCodexAdapter({ kernel })
  const events: ProviderEvent[] = []
  let textReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    textReady = resolve
  })
  const args: StartTurnArgs = {
    bot: { homeDir: "/test/bot", access: "full", approvals: "never", model: null, reasoningEffort: null } as Bot,
    thread: { id: "thread" } as Thread,
    session:
      scenario === "codex-resume"
        ? ({ externalSessionId: "test-session", rolloutPath: null } as StartTurnArgs["session"])
        : null,
    fingerprint: { cwd: "/test" } as StartTurnArgs["fingerprint"],
    developerInstructions: "Confira a fila.",
    handoffPacket: null,
    input: [{ type: "text", text: "Confira a fila." }],
    mcp: { command: "test-mcp", args: [], env: {} },
    env: {},
    signal: new AbortController().signal,
    execution: { spawn, writeFile: async () => undefined },
    onEvent: (event) => {
      events.push(event)
      if (event.type === "text_delta") textReady()
    },
  }
  const running = adapter.startTurn(args)
  try {
    await ready
    expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.delta)).toEqual(
      scenario === "claude-progress"
        ? []
        : provider === "claude"
          ? ["Conferindo ", "a fila.", "Verificando o lock."]
          : ["Conferindo ", "a fila."],
    )
    if (scenario === "claude-progress")
      expect(
        events.filter((event) => event.type === "reasoning_progress").map((event) => event.estimatedTokens),
      ).toEqual([0, 120, 350, 350, 400])
    if (provider === "codex") {
      expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ summary: "auto" })
      expect(
        requests.some((request) => request.method === (scenario === "codex-resume" ? "thread/resume" : "thread/start")),
      ).toBe(true)
    }
    expect(events.some((event) => event.type === "turn_completed")).toBe(false)
  } finally {
    send(
      provider === "claude"
        ? { type: "result", is_error: false, result: "" }
        : { method: "turn/completed", params: { status: "succeeded" } },
    )
    expect((await running).success).toBe(true)
  }
})
