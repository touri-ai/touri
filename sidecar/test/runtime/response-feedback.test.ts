import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Provider, ProviderAdapter, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const waitFor = async (ready: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("Provider did not start")
    await Bun.sleep(5)
  }
}

test.each(["codex", "claude", "opencode"] as Provider[])(
  "%s publishes provider invocation before its first event and persists it",
  async (provider) => {
    const root = mkdtempSync(join(tmpdir(), "touri-response-feedback-"))
    const runtime = createKernel({ appData: join(root, "app") })
    await initStore(runtime.kernel)
    const db = runtime.kernel.db as Database
    db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste',?,?,1,1)").run(
      provider,
      join(root, "workspace"),
    )
    db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
    let turn: StartTurnArgs | undefined
    let calls = 0
    const adapter: ProviderAdapter = {
      provider,
      detect: async () => ({ success: true, path: "/tmp/test-provider", version: "1", loggedIn: true }),
      startTurn: async (args) => {
        calls++
        turn = args
        // Timestamp must already be in the durable run when provider code first executes.
        expect(createRuntimePersistence({ database: db }).listRuns("t")[0]?.providerStartedAt).toBeNumber()
        await new Promise<void>((resolve) => args.signal.addEventListener("abort", () => resolve(), { once: true }))
        return { success: false, errorCode: "canceled", error: "Canceled" }
      },
      answerApproval: async () => ({ success: true }),
      shutdown: async () => {},
    }
    const engine = createRuntimeEngine({
      kernel: runtime.kernel,
      providerAdapters: { [provider]: adapter },
      environment: { PATH: "/usr/bin", HOME: root },
      interruptGraceMs: 10,
    })
    try {
      const store = runtime.kernel.services.use("store.api")
      if (!store) throw new Error("Missing store")
      const request = store.insertMessage({
        message: {
          id: "request",
          threadId: "t",
          parentId: null,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: "Organize minhas notas.",
          parts: [{ type: "text", text: "Organize minhas notas." }],
          sender: null,
          source: "local",
        },
      })
      if (!request.success) throw new Error(request.error)
      const queued = engine.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
      expect(queued.success).toBe(true)
      if (!queued.success) return
      expect(queued.run.providerStartedAt).toBeUndefined()
      await waitFor(() => turn !== undefined)
      const run = engine.listRuns("t")[0]
      if (!run || run.startedAt === null) throw new Error("Missing active run")
      expect(run.status).toBe("starting")
      expect(run.providerStartedAt).toBeGreaterThanOrEqual(run.startedAt)
      expect(createRuntimePersistence({ database: db }).getRun(run.id)?.providerStartedAt).toBe(run.providerStartedAt)
      expect(calls).toBe(1)
      await engine.cancel(run.id)
      await waitFor(() => engine.listRuns("t")[0]?.status === "canceled")
      expect(engine.listRuns("t")[0]?.status).toBe("canceled")
    } finally {
      await engine.shutdown()
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
