import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, NotificationRecord, Run } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createEventBus } from "../../src/kernel/event-bus"
import { createServices } from "../../src/kernel/services"
import { init as initNotify } from "../../src/notify"
import { createNotificationStore } from "../../src/notify/store"

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-failure-attention-"))
  const db = openDatabase({ filename: join(root, "test.sqlite") })
  const events = createEventBus(db)
  const kernel = {
    db,
    services: createServices(),
    publish: events.publish,
    subscribe: events.subscribe,
    registerRoutes: () => undefined,
    redact: (value: string) => value,
    callHost: async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "No host in unit tests" }),
  } as unknown as Kernel
  await initNotify(kernel)
  const send = kernel.services.use("notify.emit")
  if (!send) throw new Error("notify.emit missing")
  return {
    kernel,
    send,
    close: () => {
      events.stop()
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test.each(["retry", "user", "routine"] as const)(
  "a %s run resolves only older failures on its thread",
  async (trigger) => {
    const h = await fixture()
    try {
      const send = h.send
      const store = createNotificationStore({ db: h.kernel.db as Database })
      const failures = ["turn-failed", "routine-failed", "routine-deferred"] as const
      for (const kind of failures)
        send({ kind, botId: "bot-retry", threadId: "thread-retry", title: kind, body: "Try again" })
      for (const kind of ["approval", "question", "takeover", "incident"] as const)
        send({ kind, botId: "bot-retry", threadId: "thread-retry", title: kind, body: "Still needs you" })
      const otherThread = send({
        kind: "turn-failed",
        botId: "bot-retry",
        threadId: "other-thread",
        title: "Other thread",
        body: "Keep",
      })
      const otherBot = send({
        kind: "turn-failed",
        botId: "other-bot",
        threadId: "thread-retry",
        title: "Other bot",
        body: "Keep",
      })
      const run: Run = {
        id: "retry-run",
        botId: "bot-retry",
        threadId: "thread-retry",
        provider: "codex",
        trigger,
        status: "queued",
        routineRunId: null,
        requestMessageId: null,
        replyMessageId: null,
        externalTurnId: null,
        errorClass: null,
        errorMessage: null,
        usage: null,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      const resolved: Array<NotificationRecord> = []
      const unsubscribe = h.kernel.subscribe(({ event }) => {
        if (event.type === "notification.resolved") resolved.push(event.notification)
      })
      try {
        h.kernel.publish({ type: "run.updated", run })
        expect(resolved.map((item) => item.kind)).toEqual([...failures])
        expect(resolved.every((item) => item.resolvedAt !== null && item.resolution === "expired")).toBe(true)
        expect(store.logSince({ since: 0 }).filter((entry) => entry.type === "resolved")).toHaveLength(3)
        expect(store.pending().map((item) => item.kind)).toEqual([
          "approval",
          "question",
          "takeover",
          "incident",
          "turn-failed",
          "turn-failed",
        ])
        expect(store.get(otherThread.id)?.resolvedAt).toBeNull()
        expect(store.get(otherBot.id)?.resolvedAt).toBeNull()
        h.kernel.publish({ type: "run.updated", run: { ...run, status: "running" } })
        expect(resolved).toHaveLength(3)
        const nextFailure = send({
          kind: "turn-failed",
          botId: run.botId,
          threadId: run.threadId,
          title: "Retry failed",
          body: "Try again",
        })
        ;(h.kernel.db as Database)
          .query("UPDATE notifications SET created_at = ? WHERE id = ?")
          .run(run.queuedAt + 1, nextFailure.id)
        h.kernel.publish({ type: "run.updated", run: { ...run, status: "failed", finishedAt: run.queuedAt + 1 } })
        expect(store.get(nextFailure.id)?.resolvedAt).toBeNull()
        expect(store.pending().some((item) => item.id === nextFailure.id)).toBe(true)
        h.kernel.publish({ type: "run.updated", run: { ...run, status: "running" } })
        expect(store.get(nextFailure.id)?.resolvedAt).toBeNull()
        const nextRun: Run = { ...run, id: "successful-retry", status: "starting", startedAt: run.queuedAt + 2 }
        h.kernel.publish({ type: "run.updated", run: nextRun })
        expect(store.pending().some((item) => item.id === nextFailure.id)).toBe(false)
        h.kernel.publish({
          type: "run.updated",
          run: { ...nextRun, status: "succeeded", finishedAt: run.queuedAt + 3 },
        })
        send({ kind: "done", botId: run.botId, threadId: run.threadId, title: "Done", body: "Finished" })
        expect(store.pending().some((item) => item.id === nextFailure.id)).toBe(false)
      } finally {
        unsubscribe()
      }
    } finally {
      h.close()
    }
  },
)
