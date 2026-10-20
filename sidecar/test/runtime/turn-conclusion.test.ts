import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  Message,
  MessagePart,
  ProviderAdapter,
  ProviderEvent,
  StartTurnArgs,
  StartTurnResult,
  StoreApi,
  UiEvent,
} from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import {
  createPerformanceStageTracker,
  type PerformanceStage,
  type PerformanceStageRunner,
} from "../../src/kernel/performance"
import { createRedactor } from "../../src/kernel/redact"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { turnConclusion } from "../../src/runtime/turn-conclusion"
import { init as initStore } from "../../src/store"
import { redactVmEvents } from "../../src/vm/redact-events"

const changed: MessagePart = { type: "file_change", callId: "write", paths: ["notas.md"], diff: null }
const preamble = "Vou criar o arquivo."
const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const fixture = async (
  script: (args: StartTurnArgs) => Promise<StartTurnResult> | Promise<void>,
  requestText = "Crie notas.md com três ideias.",
  options: {
    cancelAt?: PerformanceStage
    beforeFinalization?: (database: Database) => void
    afterStage?: (stage: PerformanceStage) => void
  } = {},
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-conclusion-")))
  const serve = spyOn(Bun, "serve").mockReturnValue({
    port: 0,
    stop: () => {},
  } as unknown as ReturnType<typeof Bun.serve>)
  let runtime: ReturnType<typeof createKernel>
  try {
    runtime = createKernel({ appData: root })
  } finally {
    serve.mockRestore()
  }
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex',?,1,1)").run(
    root,
  )
  db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
    startTurn: async (args) => {
      args.onEvent({ type: "turn_started", externalTurnId: "turn" })
      const result = await script(args)
      return result ?? { success: true, externalSessionId: "session", rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  let didCancel = false
  const stages = createPerformanceStageTracker()
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    if (stage === "runtime_turn_finalization") options.beforeFinalization?.(db)
    const result = stages.run(stage, action, input)
    options.afterStage?.(stage)
    if (stage === options.cancelAt && !didCancel) {
      didCancel = true
      queueMicrotask(() => {
        if (queued.success) engine.cancel(queued.run.id)
      })
    }
    return result
  }
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    providerAdapters: { codex: adapter },
    resumeBackoffMs: 0,
    ...(options.cancelAt || options.beforeFinalization || options.afterStage ? { runStage } : {}),
  })
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const events: UiEvent[] = []
  const unsubscribe = runtime.kernel.subscribe(({ event }) => events.push(structuredClone(event)))
  const request = store.insertMessage({
    message: {
      id: "request",
      threadId: "t",
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: requestText,
      parts: [{ type: "text", text: requestText }],
      sender: null,
      source: "local",
    },
  })
  if (!request.success) throw new Error(request.error)
  const queued = engine.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
  if (!queued.success) throw new Error(queued.error)
  return {
    events,
    store,
    db,
    engine,
    run: queued.run,
    finish: async () => {
      // A fresh kernel loads the login shell environment on its first turn; that takes seconds on macOS.
      const deadline = Date.now() + 15_000
      while (["queued", "starting", "running"].includes(queued.run.status)) {
        if (Date.now() > deadline) throw new Error("Turn did not finish")
        await Bun.sleep(5)
      }
      const reply = store.activePath({ threadId: "t" }).find((message) => message.role === "assistant")
      if (!reply) throw new Error("Reply missing")
      return reply
    },
    close: async () => {
      unsubscribe()
      await engine.shutdown()
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const holdFinalization = (store: StoreApi) => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const flushWritesAsync = store.flushWritesAsync
  if (!flushWritesAsync) throw new Error("Stream writer missing")

  const flush = spyOn(store, "flushWritesAsync").mockImplementationOnce(async (options) => {
    started.resolve()
    await release.promise
    await flushWritesAsync(options)
  })
  return { started: started.promise, release: release.resolve, restore: () => flush.mockRestore() }
}

test.each(["runtime_part_finalization", "runtime_output_preparation"] as const)(
  "cancellation during %s wins over a successful provider completion",
  async (stage) => {
    const f = await fixture(
      async ({ onEvent }) => {
        onEvent({
          type: "item",
          part: {
            type: "command",
            callId: "shell",
            command: "sample",
            cwd: "/workspace",
            exitCode: null,
            outputTail: "partial",
          },
        })
      },
      "Conclua a tarefa.",
      { cancelAt: stage },
    )
    cleanups.add(f.close)

    const reply = await f.finish()

    expect(reply.status).toBe("canceled")
    expect(reply.parts.find((part) => part.type === "command")).toMatchObject({
      resolution: "cancelled_by_user",
      outputTail: "partial",
    })
    expect(f.db.query("SELECT status FROM runs").all()).toEqual([{ status: "canceled" }])
  },
)

test.each(["runtime_part_finalization", "runtime_output_preparation"] as const)(
  "cancellation during failed-turn %s externalizes output before the terminal write",
  async (stage) => {
    const output = "synthetic output\n".repeat(768)
    const f = await fixture(
      async ({ onEvent }) => {
        onEvent({
          type: "item",
          part: {
            type: "command",
            callId: "shell",
            command: "sample",
            cwd: "/workspace",
            exitCode: null,
            outputTail: output,
          },
        })
        onEvent({ type: "turn_completed", status: "failed", errorClass: "tool_error", errorMessage: "Fixture failure" })
      },
      "Conclua a tarefa.",
      { cancelAt: stage },
    )
    cleanups.add(f.close)
    // The terminal preparation must not depend on a streaming store externalizing its patches.
    const append = spyOn(f.store, "appendParts").mockImplementation(() => {})
    const update = spyOn(f.store, "updateMessage")
    cleanups.add(async () => {
      append.mockRestore()
      update.mockRestore()
    })

    const reply = await f.finish()

    const terminal = update.mock.calls.find(([input]) => input.patch.status !== "streaming")?.[0]
    const command = terminal?.patch.parts?.find((part) => part.type === "command")
    expect(command).toMatchObject({
      outputTail: "",
      outputBytes: Buffer.byteLength(output),
    })
    if (command?.type !== "command" || !command.outputAttachmentId) throw new Error("Output reference missing")
    const attachment = f.db.query("SELECT path FROM attachments WHERE id = ?").get(command.outputAttachmentId) as {
      path: string
    } | null
    if (!attachment) throw new Error("Output attachment missing")
    expect(await Bun.file(attachment.path).text()).toBe(output)
    expect(reply.parts).toContainEqual(command)
    const stored = f.db.query("SELECT part_json FROM tool_resolutions WHERE call_id = 'shell'").get() as {
      part_json: string
    } | null
    expect(stored ? JSON.parse(stored.part_json) : null).toEqual(command)
  },
)

test.each(["runtime_part_finalization", "runtime_output_preparation"] as const)(
  "a late part during %s survives preparation with its complete output",
  async (stage) => {
    const output = "late synthetic result\n".repeat(768)
    let sendEvent: StartTurnArgs["onEvent"] | null = null
    let didSend = false
    const f = await fixture(
      async ({ onEvent }) => {
        sendEvent = onEvent
        onEvent({ type: "text_delta", itemId: "reply", delta: "Resultado parcial." })
      },
      "Conclua a tarefa.",
      {
        afterStage: (current) => {
          if (current !== stage || didSend) return
          didSend = true
          queueMicrotask(() => {
            sendEvent?.({
              type: "item",
              part: {
                type: "command",
                callId: "late",
                command: "sample",
                cwd: "/workspace",
                exitCode: 0,
                outputTail: output,
              },
            })
          })
        },
      },
    )
    cleanups.add(f.close)

    const reply = await f.finish()

    expect(reply.status).toBe("complete")
    const part = reply.parts.find((part) => part.type === "command" && part.callId === "late")
    expect(part).toMatchObject({ outputTail: "", outputBytes: Buffer.byteLength(output), resolution: "succeeded" })
    if (part?.type !== "command" || !part.outputAttachmentId) throw new Error("Output reference missing")
    const attachment = f.db.query("SELECT path FROM attachments WHERE id = ?").get(part.outputAttachmentId) as {
      path: string
    } | null
    if (!attachment) throw new Error("Output attachment missing")
    expect(await Bun.file(attachment.path).text()).toBe(output)
  },
)

test("finalization yields while another connection holds the writer instead of blocking timers", async () => {
  const blocker = getWriterBlocker()
  cleanups.add(blocker.close)
  const f = await fixture(async () => {}, "Conclua a tarefa.", { beforeFinalization: blocker.hold })
  cleanups.add(f.close)

  const reply = await f.finish()

  console.info(
    `finalization-writer-contention ${JSON.stringify({ timerDelayMs: blocker.getReleaseDelayMs(), status: reply.status })}`,
  )
  expect(blocker.getReleaseDelayMs()).toBeLessThan(100)
  expect(reply.status).toBe("complete")
})

const getWriterBlocker = () => {
  let writer: Database | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let releaseDelayMs = Infinity

  return {
    hold: (database: Database): void => {
      if (writer) return
      writer = new Database(database.filename)
      database.exec("PRAGMA busy_timeout = 120")
      writer.exec("BEGIN IMMEDIATE")
      const startedAt = performance.now()
      timer = setTimeout(() => {
        releaseDelayMs = performance.now() - startedAt
        writer?.exec("ROLLBACK")
      }, 15)
    },
    getReleaseDelayMs: () => releaseDelayMs,
    close: async (): Promise<void> => {
      if (timer) clearTimeout(timer)
      if (writer?.inTransaction) writer.exec("ROLLBACK")
      writer?.close()
    },
  }
}

test("cancellation during crash finalization never continues the canceled turn", async () => {
  const streamedText = "A resposta parcial antes da falha."
  const providerStarted = Promise.withResolvers<void>()
  const releaseProvider = Promise.withResolvers<void>()
  const f = await fixture(async ({ onEvent }) => {
    onEvent({ type: "session", externalSessionId: "session", rolloutPath: null })
    onEvent({ type: "text_delta", itemId: "answer", delta: streamedText })
    providerStarted.resolve()
    await releaseProvider.promise
    return { success: false, errorCode: "cli_crash", error: "Fixture provider crashed" }
  })
  const finalization = holdFinalization(f.store)
  cleanups.add(async () => {
    releaseProvider.resolve()
    finalization.release()
    finalization.restore()
    await f.close()
  })
  await providerStarted.promise
  f.db.exec("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','true',1)")

  releaseProvider.resolve()
  await finalization.started
  const canceled = f.engine.cancelRuns([f.run.id])
  finalization.release()
  await canceled
  await f.engine.waitForDrain()

  const runs = f.engine.listRuns("t")
  const path = f.store.activePath({ threadId: "t" })
  const reply = path.find((message) => message.role === "assistant")
  const resumed = path.some((message) =>
    message.parts.some((part) => part.type === "notice" && part.code === "run_resumed"),
  )
  expect(runs).toHaveLength(1)
  expect(runs).toMatchObject([{ id: f.run.id, status: "canceled", errorClass: "canceled" }])
  expect(reply?.status).toBe("canceled")
  expect(reply?.text).toBe(streamedText)
  expect(reply?.parts).toContainEqual({ type: "text", text: streamedText })
  expect(resumed).toBe(false)
  expect(f.engine.activeRun({ threadId: "t" })).toBeNull()
})

test.each([
  ["Crie notas.md com três ideias.", "Concluído. Arquivos alterados: notas.md."],
  ["Please create notas.md with three ideas.", "Done. Files changed: notas.md."],
])("a tool-only ending gets a confirmed summary: %s", async (request, summary) => {
  const f = await fixture(async ({ onEvent }) => {
    onEvent({ type: "text_delta", itemId: "intro", delta: preamble })
    onEvent({ type: "item", part: changed })
  }, request)
  try {
    const reply = await f.finish()
    expect(reply.status).toBe("complete")
    expect(reply.text).toBe(`${preamble}\n\n${summary}`)
    expect(reply.parts.map((part) => part.type)).toEqual(["text", "file_change", "text"])
    expect(reply.parts.at(-1)).toEqual({ type: "text", text: `\n\n${summary}` })
  } finally {
    await f.close()
  }
})

test.each(["closing", "intro"])(
  "closing item %s stays after tools and precedes complete, even after turn_completed",
  async (itemId) => {
    const closing = "Pronto: criei notas.md com três ideias."
    const f = await fixture(async ({ onEvent }) => {
      onEvent({ type: "text_delta", itemId: "intro", delta: preamble })
      onEvent({ type: "item", part: changed })
      onEvent({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
      await Bun.sleep(10)
      onEvent({ type: "text_delta", itemId, delta: closing.slice(0, 15) })
      await Bun.sleep(10)
      onEvent({ type: "text_delta", itemId, delta: closing.slice(15) })
    })
    try {
      const reply = await f.finish()
      expect(reply.text).toBe(`${preamble}\n\n${closing}`)
      expect(reply.parts.map((part) => part.type)).toEqual(["text", "file_change", "text"])
      const completed = f.events.findIndex(
        (event) =>
          event.type === "message.updated" && event.message.role === "assistant" && event.message.status === "complete",
      )
      expect(completed).toBeGreaterThan(0)
      const deltas = f.events.filter((event) => event.type === "message.delta")
      expect(deltas.at(-1)).toMatchObject({ partIndex: 2 })
      expect(
        deltas
          .filter((event) => event.partIndex === 2)
          .map((event) => event.delta)
          .join(""),
      ).toBe(`\n\n${closing}`)
      expect(f.events.slice(completed + 1).some((event) => event.type === "message.delta")).toBe(false)
      const terminal = f.events[completed] as { type: "message.updated"; message: Message }
      expect(terminal.message.text).toBe(reply.text)
      expect(terminal.message.parts).toEqual(reply.parts)
      expect(f.db.query("SELECT text, status FROM messages WHERE id = ?").get(reply.id)).toEqual({
        text: reply.text,
        status: "complete",
      })
    } finally {
      await f.close()
    }
  },
)

test.each([
  [
    { type: "command", callId: "shell", command: "cat > invented.md", cwd: "/workspace", exitCode: 0, outputTail: "" },
    "Concluído.",
  ],
  [
    {
      type: "command",
      callId: "shell",
      command: "write invented.md",
      cwd: "/workspace",
      exitCode: 1,
      outputTail: "error",
    },
    "Não foi possível concluir todas as ações.",
  ],
  [
    {
      type: "command",
      callId: "shell",
      command: "write invented.md",
      cwd: "/workspace",
      exitCode: null,
      outputTail: "",
    },
    "A resposta terminou, mas não foi possível confirmar o resultado das ações.",
  ],
  [{ ...changed, resolution: "failed" }, "Não foi possível concluir todas as ações."],
  [
    { type: "approval", approvalId: "denied", request: "file_change", decision: "denied", detail: "invented.md" },
    "Uma ação não foi autorizada.",
  ],
] satisfies Array<[MessagePart, string]>)(
  "unverified paths never become claimed results: %j",
  async (part, summary) => {
    const f = await fixture(async ({ onEvent }) => onEvent({ type: "item", part }))
    try {
      const reply = await f.finish()
      expect(reply.text).toBe(summary)
      expect(reply.text).not.toContain("invented.md")
      expect(reply.text).not.toContain("notas.md")
    } finally {
      await f.close()
    }
  },
)

test.each(["Write", "Edit", "write", "edit"])("confirmed native %s results include the file path", (tool) => {
  expect(
    turnConclusion({
      requestText: "Crie notas.md.",
      parts: [
        {
          type: "tool_call",
          callId: "write",
          tool,
          summary: "",
          inputJson: '{"file_path":"notas.md"}',
          outputJson: "done",
          ok: true,
        },
      ],
    }),
  ).toBe("Concluído. Arquivos alterados: notas.md.")
})

test("an external tool's requested path is not evidence of a file change", () => {
  expect(
    turnConclusion({
      requestText: "Create a file.",
      parts: [
        {
          type: "tool_call",
          callId: "external",
          tool: "mcp__external__Write",
          summary: "",
          inputJson: '{"file_path":"invented.md"}',
          outputJson: "done",
          ok: true,
        },
      ],
    }),
  ).toBe("Done.")
})

test("turns without tool activity do not get an extra conclusion", () => {
  expect(turnConclusion({ parts: [{ type: "text", text: "Olá!" }], requestText: "Oi" })).toBeNull()
})

test("a trailing reasoning segment or whitespace cannot substitute for closing text", () => {
  expect(
    turnConclusion({
      parts: [changed, { type: "reasoning", text: "Conferindo." }, { type: "text", text: "  " }],
      requestText: "Crie notas.md e responda em inglês.",
    }),
  ).toBe("Done. Files changed: notas.md.")
})

test("buffered closing text after tool activity prevents a duplicate conclusion", () => {
  expect(
    turnConclusion({
      parts: [changed, { type: "text", text: "" }],
      requestText: "Implemente.",
      pendingPartText: new Map([[1, { type: "text", chunks: ["Código entregue"] }]]),
    }),
  ).toBeNull()
})

test("buffered text before the latest tool activity still gets a conclusion", () => {
  expect(
    turnConclusion({
      parts: [{ type: "text", text: "" }, changed],
      requestText: "Crie notas.md.",
      pendingPartText: new Map([[0, { type: "text", chunks: ["Implementei."] }]]),
    }),
  ).toBe("Concluído. Arquivos alterados: notas.md.")
})

test("buffered redaction tails stay before tools and before new text items", () => {
  const redactor = createRedactor()
  redactor.addRedactionValue("fixture-credential")
  const providerEvents: ProviderEvent[] = []
  const emit = redactVmEvents({ secrets: [], redact: redactor.redact, emit: (event) => providerEvents.push(event) })
  emit({ type: "text_delta", itemId: "intro", delta: "Vou criar f" })
  emit({ type: "item", part: changed })
  emit({ type: "text_delta", itemId: "closing", delta: "Pronto f" })
  emit({ type: "text_delta", itemId: "next", delta: "Outro texto." })
  emit.flush()
  expect(providerEvents.map((event) => event.type)).toEqual([
    "text_delta",
    "text_delta",
    "item",
    "text_delta",
    "text_delta",
    "text_delta",
  ])
  expect(providerEvents[1]).toEqual({ type: "text_delta", itemId: "intro", delta: "f" })
  expect(providerEvents[4]).toEqual({ type: "text_delta", itemId: "closing", delta: "f" })
})
