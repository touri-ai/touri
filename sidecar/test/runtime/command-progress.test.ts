import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  Bot,
  CommandPart,
  Kernel,
  Message,
  ProviderEvent,
  StartTurnArgs,
  Thread,
  ToolCallPart,
} from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

const secret = "fixture-command-credential"

type Frame = Record<string, unknown>

const fixture = (provider: "codex" | "claude", frames: Frame[]) => {
  const root = mkdtempSync(join(tmpdir(), "touri-command-progress-"))
  const serve = spyOn(Bun, "serve").mockReturnValue({
    port: 0,
    stop: () => {},
  } as unknown as ReturnType<typeof Bun.serve>)
  let runtime: ReturnType<typeof createKernel>
  try {
    runtime = createKernel({ appData: join(root, "data") })
  } finally {
    serve.mockRestore()
  }
  runtime.kernel.addRedactionValue(secret)
  // Script the actual provider wire protocol without a network listener or subprocess.
  const spawn: Kernel["spawnTree"] = () => {
    let stdout: ReadableStreamDefaultController<Uint8Array>
    let stderr: ReadableStreamDefaultController<Uint8Array>
    let finish: (value: { code: number; signal: null }) => void = () => {}
    let closed = false
    const encoder = new TextEncoder()
    const send = (value: Frame) => stdout.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
    const run = async () => {
      send(
        provider === "codex"
          ? { method: "turn/started", params: { turnId: "turn" } }
          : { type: "system", subtype: "init", session_id: "session" },
      )
      for (const frame of frames) {
        if (typeof frame.delay === "number") await Bun.sleep(frame.delay)
        if (closed) return
        send(frame)
      }
      if (!closed)
        send(
          provider === "codex"
            ? { method: "turn/completed", params: { status: "succeeded" } }
            : { type: "result", subtype: "success", is_error: false },
        )
    }
    return {
      success: true,
      target: "remote",
      pid: 1,
      pgid: 1,
      extra: [],
      stdout: new ReadableStream({
        start: (controller) => {
          stdout = controller
        },
      }),
      stderr: new ReadableStream({
        start: (controller) => {
          stderr = controller
        },
      }),
      stdin: new WritableStream({
        write: (chunk) => {
          const request = JSON.parse(new TextDecoder().decode(chunk)) as Frame
          if (request.id !== undefined)
            send({ id: request.id, result: request.method === "thread/start" ? { thread: { id: "session" } } : {} })
          if (request.method === "turn/start" || request.type === "user") void run()
        },
      }),
      exited: new Promise((resolve) => {
        finish = resolve
      }),
      kill: () => {
        if (closed) return
        closed = true
        stdout.close()
        stderr.close()
        finish({ code: 0, signal: null })
      },
    }
  }
  const adapter = (provider === "codex" ? createCodexAdapter : createClaudeAdapter)({
    kernel: { ...runtime.kernel, spawnTree: spawn },
    command: process.execPath,
  })
  return {
    root,
    runtime,
    adapter,
    close: async () => {
      await adapter.shutdown()
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} emits redacted command output before completion, preserving call identity`, async () => {
    const bulk = "progress line\n".repeat(2_000)
    const finalOutput = "complete output\n".repeat(5_000)
    const events =
      provider === "codex"
        ? [
            {
              method: "item/started",
              params: { item: { type: "commandExecution", id: "shell", command: "bun test", cwd: "/workspace" } },
            },
            { method: "item/commandExecution/outputDelta", params: { itemId: "shell", delta: "step 1\n" } },
            { method: "item/commandExecution/outputDelta", params: { itemId: "shell", delta: bulk } },
            { method: "item/commandExecution/outputDelta", params: { itemId: "shell", delta: "fixture-command-" } },
            {
              method: "item/commandExecution/outputDelta",
              params: { itemId: "shell", delta: "credential\nAPI_TOKEN=fixture-" },
            },
            { method: "item/commandExecution/outputDelta", params: { itemId: "shell", delta: "cli-value\nstep 2\n" } },
            {
              method: "item/completed",
              params: { item: { type: "commandExecution", id: "shell", exitCode: 0, aggregatedOutput: finalOutput } },
            },
          ]
        : [
            {
              type: "assistant",
              message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: { command: "bun test" } }] },
            },
            { type: "tool_progress", tool_use_id: "shell", tool_name: "Bash", elapsed_time_seconds: 1 },
            {
              type: "progress",
              parentToolUseID: "shell",
              toolUseID: "bash-progress-0",
              data: { type: "bash_progress", fullOutput: "step 1\n" },
            },
            {
              type: "progress",
              parentToolUseID: "shell",
              toolUseID: "bash-progress-1",
              data: { type: "bash_progress", fullOutput: `step 1\n${bulk}${secret}\nstep 2\n` },
            },
            {
              type: "progress",
              parentToolUseID: "shell",
              toolUseID: "bash-progress-2",
              data: { type: "bash_progress", fullOutput: `step 1\n${bulk}${secret}\nstep 3\n` },
            },
            {
              type: "user",
              message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "done", is_error: false }] },
            },
          ]
    const value = fixture(provider, events)
    const { root, adapter } = value
    const received: ProviderEvent[] = []
    const args: StartTurnArgs = {
      bot: { access: "full", approvals: "never", homeDir: root, model: null, reasoningEffort: null } as Bot,
      thread: { id: "command-thread" } as Thread,
      session: null,
      fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
      input: [{ type: "text", text: "Run the checks." }],
      developerInstructions: "Test command progress.",
      handoffPacket: null,
      mcp: { command: process.execPath, args: [], env: {} },
      env: { HOME: root },
      signal: new AbortController().signal,
      onEvent: (event) => received.push(structuredClone(event)),
    }
    try {
      expect(await adapter.startTurn(args)).toMatchObject({ success: true })
      const parts = received.flatMap((event) => (event.type === "item" ? [event.part] : []))
      const live = parts.filter(
        (part) =>
          (part.type === "command" && part.exitCode === null) || (part.type === "tool_call" && part.ok === null),
      )
      expect(live.some((part) => "outputTail" in part && part.outputTail === "step 1\n")).toBe(true)
      expect(live.some((part) => "outputTail" in part && part.outputTail?.endsWith("step 2\n"))).toBe(true)
      expect(
        live.every((part) => ("outputTail" in part ? Buffer.byteLength(part.outputTail ?? "") <= 16 * 1024 : true)),
      ).toBe(true)
      expect(parts.every((part) => "callId" in part && part.callId === "shell")).toBe(true)
      expect(JSON.stringify(received)).not.toContain(secret)
      expect(JSON.stringify(received)).not.toContain("fixture-command-")
      expect(JSON.stringify(received)).not.toContain("cli-value")
      expect(JSON.stringify(received)).toContain("[REDACTED]")
      expect(parts[0]).toMatchObject({
        outputMode: provider === "codex" ? "streaming" : "on_completion",
        startedAt: expect.any(Number),
      })
      expect(parts.at(-1)).toMatchObject(provider === "codex" ? { exitCode: 0 } : { ok: true, outputJson: "done" })
      if (provider === "codex") expect(parts.at(-1)).toMatchObject({ outputTail: finalOutput })
      else expect(live.at(-1)).toMatchObject({ outputTail: expect.stringContaining("step 3\n") })
    } finally {
      await value.close()
    }
  })
}

for (const type of ["command", "tool_call"] as const) {
  test(`engine bounds and throttles ${type} output, flushing the final tail without a late timer`, async () => {
    const value = fixture("codex", [])
    const { kernel } = value.runtime
    const db = kernel.db as Database
    db.query(
      "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Fixture','codex',?,1,1)",
    ).run(value.root)
    db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Checks',1,1)")
    await initStore(kernel)
    const store = kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    const engine = createRuntimeEngine({
      kernel,
      providerAdapters: {
        codex: {
          ...value.adapter,
          startTurn: async (args) => {
            const part: CommandPart | ToolCallPart =
              type === "command"
                ? { type, callId: "shell", command: "bun test", cwd: "/workspace", exitCode: null, outputTail: "" }
                : {
                    type,
                    callId: "shell",
                    tool: "Bash",
                    summary: "Run checks",
                    inputJson: "{}",
                    outputJson: null,
                    ok: null,
                    outputTail: "",
                  }
            args.onEvent({ type: "turn_started", externalTurnId: "turn" })
            args.onEvent({ type: "item", part: { ...part } })
            for (let index = 0; index < 100; index += 1) {
              part.outputTail = `${part.outputTail ?? ""}line ${index}: ${"界".repeat(100)}\n`
              args.onEvent({ type: "item", part: { ...part } })
            }
            part.outputTail += `${secret}\nstep 1\n`
            args.onEvent({ type: "item", part: { ...part } })
            await Bun.sleep(400)
            args.onEvent({ type: "item", part: { ...part, outputTail: "step 1\nstep 2\n" } })
            args.onEvent({
              type: "item",
              part:
                part.type === "command"
                  ? { ...part, outputTail: "step 1\nstep 2\n", exitCode: 0 }
                  : { ...part, outputTail: "step 1\nstep 2\n", outputJson: "done", ok: true },
            })
            return { success: true, externalSessionId: "session", rolloutPath: null, status: "succeeded" }
          },
        },
      },
      environment: { PATH: process.env.PATH ?? "/usr/bin" },
    })
    const snapshots: Message[] = []
    const unsubscribe = kernel.subscribe(({ event }) => {
      if ((event.type === "message.created" || event.type === "message.updated") && event.message.role === "assistant")
        snapshots.push(structuredClone(event.message))
    })
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Command progress was not published")
        await Bun.sleep(5)
      }
    }
    try {
      const request = store.insertMessage({
        message: {
          id: "request",
          threadId: "t",
          parentId: null,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: "Run checks.",
          parts: [],
          sender: null,
          source: "local",
        },
      })
      if (!request.success) throw new Error(request.error)
      const queued = engine.enqueue({ threadId: "t", requestMessageId: "request", trigger: "user" })
      if (!queued.success) throw new Error(queued.error)
      await waitFor(() => snapshots.some((message) => JSON.stringify(message.parts).includes("step 1")))
      expect(queued.run.status).toBe("running")
      const live = snapshots.flatMap((message) =>
        message.parts.filter(
          (part) =>
            ((part.type === "command" && part.exitCode === null) || (part.type === "tool_call" && part.ok === null)) &&
            part.outputTail,
        ),
      )
      expect(live.length).toBeGreaterThan(0)
      expect(live.length).toBeLessThanOrEqual(2)
      for (const part of live) {
        if (part.type !== "command" && part.type !== "tool_call") continue
        expect(Buffer.byteLength(part.outputTail ?? "")).toBeLessThanOrEqual(16 * 1024)
        expect(part.outputTail).not.toContain("\uFFFD")
      }
      expect(JSON.stringify(snapshots)).not.toContain(secret)
      expect(JSON.stringify(snapshots)).toContain("[REDACTED]")
      await waitFor(() => snapshots.at(-1)?.status === "complete")
      const final = snapshots.at(-1)?.parts.find((part) => part.type === type)
      expect(final).toMatchObject(
        type === "command" ? { exitCode: 0, resolution: "succeeded" } : { ok: true, resolution: "succeeded" },
      )
      expect(final && "outputTail" in final && final.outputTail?.endsWith("step 1\nstep 2\n")).toBe(true)
      const count = snapshots.length
      await Bun.sleep(300)
      expect(snapshots).toHaveLength(count)
    } finally {
      unsubscribe()
      await engine.shutdown()
      await value.close()
    }
  })
}
