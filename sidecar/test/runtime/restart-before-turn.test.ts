import { expect, test } from "bun:test"
import type { ImagePart, ProviderAdapter, StartTurnArgs, StartTurnResult } from "@touri/contracts"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Turn did not reach the expected state")
    await Bun.sleep(5)
  }
}

for (const provider of ["codex", "claude"] as const) {
  test.each(["starting", "running", "interrupted", "resumed"] as const)(
    `${provider}: restart from %s preserves the request context`,
    async (phase) => {
      const f = testKernel()
      const engines: ReturnType<typeof createRuntimeEngine>[] = []
      try {
        await initStore(f.kernel)
        f.db
          .query(
            "INSERT INTO bots(id,name,provider,provider_profile,home_dir,browser_enabled,notifications,created_at,updated_at) VALUES ('b','Fixture',?,'fixture',?,0,'none',1,1)",
          )
          .run(provider, f.kernel.paths.appData)
        f.db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Fixture',1,1)")
        const store = f.kernel.services.use("store.api")
        if (!store) throw new Error("Store missing")
        const turns: StartTurnArgs[] = []
        const adapter: ProviderAdapter = {
          provider,
          detect: async () => ({ success: true, path: "/tmp/fixture-provider", version: "1", loggedIn: true }),
          startTurn: async (args) => {
            turns.push(args)
            args.onEvent({ type: "session", externalSessionId: "fixture-session", rolloutPath: null })
            if (turns.length === 1 || (phase === "resumed" && turns.length === 2)) {
              if (phase === "running" || turns.length === 2)
                args.onEvent({ type: "turn_started", externalTurnId: "original-turn" })
              // Pause with a durable session at the selected startup phase.
              return new Promise<StartTurnResult>((resolve) => {
                args.signal.addEventListener(
                  "abort",
                  () => resolve({ success: false, errorCode: "canceled", error: "Fixture stopped" }),
                  { once: true },
                )
              })
            }
            args.onEvent({ type: "turn_started", externalTurnId: "fixture-turn" })
            args.onEvent({ type: "text_delta", itemId: "answer", delta: "Pedido retomado e concluído." })
            return { success: true, externalSessionId: "fixture-session", rolloutPath: null, status: "succeeded" }
          },
          answerApproval: async () => ({ success: true }),
          shutdown: async () => {},
        }
        const open = () => {
          const engine = createRuntimeEngine({
            kernel: f.kernel,
            providerAdapters: { [provider]: adapter },
            environment: { PATH: "/usr/bin:/bin", HOME: f.kernel.paths.appData },
          })
          engines.push(engine)
          return engine
        }
        const first = open()
        const text = `${"Request context. ".repeat(120)}Use the attached image to finish the requested task.`
        const image: ImagePart = { type: "image", attachmentId: "fixture-image", mime: "image/png" }
        const request = store.insertMessage({
          message: {
            id: "request",
            threadId: "t",
            parentId: null,
            role: "user",
            kind: "text",
            status: "complete",
            runId: null,
            text,
            parts: [{ type: "text", text }, image],
            sender: null,
            source: "local",
          },
        })
        if (!request.success) throw new Error(request.error)
        const queued = first.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
        if (!queued.success) throw new Error(queued.error)
        await waitFor(() => turns.length === 1)
        if (phase === "interrupted") await first.shutdown()
        expect(first.listRuns("t")[0]).toMatchObject({
          status: phase === "resumed" ? "starting" : phase,
          externalTurnId: phase === "running" ? "original-turn" : null,
        })
        // A fresh engine fences the crashed writer and uses its persisted resume point.
        let restarted = open()
        if (phase === "resumed") {
          await waitFor(() => turns.length === 2 && restarted.listRuns("t")[0]?.status === "running")
          expect(turns[1]?.input).toContainEqual(image)
          // Once a continuation has accepted the request, a second restart must not resend it.
          restarted = open()
        }
        await waitFor(() => restarted.listRuns("t")[0]?.status === "succeeded")
        expect(restarted.listRuns("t")).toMatchObject([
          { status: "succeeded", trigger: "retry" },
          ...(phase === "resumed" ? [{ status: "interrupted", errorClass: "app_restart" }] : []),
          { id: queued.run.id, status: "interrupted", errorClass: "app_restart" },
        ])
        expect(turns).toHaveLength(phase === "resumed" ? 3 : 2)
        const lastTurn = turns.at(-1)
        expect(lastTurn?.session?.externalSessionId).toBe("fixture-session")
        const resumedText = lastTurn?.input
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        if (phase === "running" || phase === "resumed") {
          // An acknowledged turn already has the original input in its native session.
          expect(resumedText).not.toContain(text)
          expect(lastTurn?.input).not.toContainEqual(image)
        } else {
          expect(resumedText).toContain(text)
          expect(lastTurn?.input).toContainEqual(image)
        }
        expect(store.activePath({ threadId: "t" }).find((message) => message.id === request.message.id)?.text).toBe(
          text,
        )
        expect(f.spawnTree).not.toHaveBeenCalled()
      } finally {
        for (const engine of engines.reverse()) await engine.shutdown()
        f.close()
      }
    },
  )
}
