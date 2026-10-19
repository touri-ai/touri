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

test("a successful completion resolves older attention even when its starting events were missed", async () => {
  const h = await fixture()
  try {
    const store = createNotificationStore({ db: h.kernel.db as Database })
    const failure = h.send({ kind: "turn-failed", botId: "bot", threadId: "thread", title: "Failed", body: "Retry" })
    const other = h.send({ kind: "turn-failed", botId: "bot", threadId: "other", title: "Failed", body: "Keep" })
    const approval = h.send({ kind: "approval", botId: "bot", threadId: "thread", title: "Approval", body: "Keep" })
    const run: Run = {
      id: "success",
      botId: "bot",
      threadId: "thread",
      provider: "codex",
      trigger: "user",
      status: "succeeded",
      routineRunId: null,
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      queuedAt: failure.createdAt + 1,
      startedAt: failure.createdAt + 2,
      finishedAt: failure.createdAt + 3,
    }
    h.kernel.publish({ type: "run.updated", run })
    expect(store.get(failure.id)?.resolution).toBe("expired")
    expect(store.recent(20).find((item) => item.id === failure.id)?.resolvedAt).not.toBeNull()
    expect(store.get(other.id)?.resolvedAt).toBeNull()
    expect(store.get(approval.id)?.resolvedAt).toBeNull()
    expect(store.logSince({ since: 0 }).filter((entry) => entry.type === "resolved")).toHaveLength(1)
    h.kernel.publish({ type: "run.updated", run })
    expect(store.logSince({ since: 0 }).filter((entry) => entry.type === "resolved")).toHaveLength(1)
  } finally {
    h.close()
  }
})

test("startup resolves persisted failures after a later success, including a group member thread", async () => {
  const h = await fixture()
  try {
    const db = h.kernel.db as Database
    db.query(
      "INSERT INTO bots (id, name, provider, home_dir, created_at, updated_at) VALUES ('bot', 'Bot', 'codex', '.', 1, 1)",
    ).run()
    db.query(
      "INSERT INTO threads (id, bot_id, title, created_at, updated_at) VALUES ('group', 'bot', 'Grupo', 1, 1)",
    ).run()
    db.query(
      "INSERT INTO threads (id, bot_id, title, created_at, updated_at, group_thread_id) VALUES ('member', 'bot', 'Conversa', 1, 1, 'group')",
    ).run()
    const old = h.send({ kind: "turn-failed", botId: "bot", threadId: "group", title: "Failed", body: "Retry" })
    const recent = h.send({ kind: "turn-failed", botId: "bot", threadId: "group", title: "New failure", body: "Keep" })
    const other = h.send({ kind: "turn-failed", botId: "bot", threadId: "other", title: "Other", body: "Keep" })
    db.query("UPDATE notifications SET created_at = ? WHERE id = ?").run(100, old.id)
    db.query("UPDATE notifications SET created_at = ? WHERE id = ?").run(400, recent.id)
    db.query(
      "INSERT INTO runs (id, thread_id, bot_id, provider, trigger, status, queued_at, started_at, finished_at) VALUES ('success', 'member', 'bot', 'codex', 'user', 'succeeded', 200, 210, 300)",
    ).run()
    await initNotify(h.kernel)
    const store = createNotificationStore({ db })
    expect(store.get(old.id)?.resolution).toBe("expired")
    expect(store.get(recent.id)?.resolvedAt).toBeNull()
    expect(store.get(other.id)?.resolvedAt).toBeNull()
    expect(store.recent(10)).toHaveLength(3)
  } finally {
    h.close()
  }
})

test("repeated routine deferrals collapse into one and a later run of that routine resolves it", async () => {
  const h = await fixture()
  try {
    const store = createNotificationStore({ db: h.kernel.db as Database })
    const database = h.kernel.db as Database
    database.exec("PRAGMA foreign_keys = OFF")
    database
      .query(
        "INSERT INTO routine_runs (id, routine_id, scheduled_for, status, trigger_source) VALUES ('routine-run-1', 'routine-1', 1, 'running', 'cron')",
      )
      .run()
    const deferral = {
      kind: "routine-deferred",
      botId: "bot-routine",
      threadId: null,
      requestId: "routine-deferred:routine-1",
      title: "Rotina adiada: Resumo",
      body: "A rotina não foi executada.",
    } as const
    const first = h.send(deferral)
    const second = h.send(deferral)
    h.send({ ...deferral, requestId: "routine-deferred:routine-2" })
    expect(second.id).toBe(first.id)
    expect(store.pending().filter((item) => item.kind === "routine-deferred")).toHaveLength(2)
    const run: Run = {
      id: "routine-run-turn",
      botId: "bot-routine",
      threadId: "routine-thread",
      provider: "codex",
      trigger: "routine",
      status: "running",
      routineRunId: "routine-run-1",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      queuedAt: 10,
      startedAt: 11,
      finishedAt: null,
    }
    h.kernel.publish({ type: "run.updated", run })
    expect(store.get(first.id)?.resolvedAt).not.toBeNull()
    expect(store.pending().map((item) => item.requestId)).toEqual(["routine-deferred:routine-2"])
    expect(h.send(deferral).id).not.toBe(first.id)
    expect(store.pending()).toHaveLength(2)
  } finally {
    h.close()
  }
})
