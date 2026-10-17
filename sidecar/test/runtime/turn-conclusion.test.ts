import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message, MessagePart, ProviderAdapter, ProviderEvent, StartTurnArgs, UiEvent } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createRedactor } from "../../src/kernel/redact"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { turnConclusion } from "../../src/runtime/turn-conclusion"
import { init as initStore } from "../../src/store"
import { redactVmEvents } from "../../src/vm/redact-events"

const changed: MessagePart = { type: "file_change", callId: "write", paths: ["notas.md"], diff: null }
const preamble = "Vou criar o arquivo."

const fixture = async (
  script: (args: StartTurnArgs) => Promise<void>,
  requestText = "Crie notas.md com três ideias.",
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
      await script(args)
      return { success: true, externalSessionId: "session", rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const engine = createRuntimeEngine({ kernel: runtime.kernel, providerAdapters: { codex: adapter } })
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
    finish: async () => {
      // A fresh kernel loads the login shell environment on its first turn; that takes seconds on macOS.
      const deadline = Date.now() + 15_000
      while (queued.run.status !== "succeeded") {
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
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

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
      expect(deltas.at(-1)).toMatchObject({ partIndex: 2, delta: closing.slice(15) })
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
