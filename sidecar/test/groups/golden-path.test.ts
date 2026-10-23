import type { Database } from "bun:sqlite"
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { createWorkState } from "../../src/runtime/work-state"
import { init as initStore } from "../../src/store"

setDefaultTimeout(20_000)

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Synthetic turn did not finish")
    await Bun.sleep(10)
  }
}

const fixture = async (
  onTurn?: (run: Run, complete: (text: string) => void) => Promise<void>,
  ready = Promise.resolve(),
) => {
  const root = await mkdtemp(join(tmpdir(), "touri-golden-unit-"))
  const host = createKernel({ appData: root })
  const closeHost = async () => {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
  cleanups.add(closeHost)
  await initStore(host.kernel)
  const db = host.kernel.db as Database
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const bots = ["Lia", "Bia"].map((name) => {
    const id = host.kernel.newId()
    db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,'codex',?,1,1)").run(
      id,
      name,
      root,
    )
    const bot = store.getBot({ botId: id })
    if (!bot) throw new Error("Synthetic bot missing")
    return bot
  })
  const data = createGroupStore(host.kernel)
  const group = data.save({
    name: "Planejamento",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: bots.map((bot) => bot.id),
    coordinatorBotId: null,
  })
  const thread = data.createThread(group)
  const persistence = createRuntimePersistence({ database: db })
  // Recording is local to the fake provider, never shared by tests.
  const order: string[] = []
  const finish = (run: Run, patch: Partial<Run>) => {
    const updated = { ...run, ...patch }
    persistence.saveRun(updated)
    host.kernel.publish({ type: "run.updated", run: updated })
  }
  const engine = {
    ready,
    enqueue: (args: { threadId: string; requestMessageId: string; trigger: Run["trigger"] }) => {
      const run: Run = {
        id: host.kernel.newId(),
        threadId: args.threadId,
        requestMessageId: args.requestMessageId,
        botId: store.getThread({ threadId: args.threadId })?.botId ?? "",
        provider: "codex",
        trigger: args.trigger,
        status: "queued",
        replyMessageId: null,
        externalTurnId: null,
        errorClass: null,
        errorMessage: null,
        usage: null,
        routineRunId: null,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      persistence.saveRun(run)
      queueMicrotask(async () => {
        finish(run, { status: "running", startedAt: Date.now() })
        order.push(run.botId)
        const complete = (text: string) => {
          const reply = store.insertMessage({
            message: {
              id: host.kernel.newId(),
              threadId: run.threadId,
              parentId: args.requestMessageId,
              role: "assistant",
              kind: "text",
              status: "complete",
              runId: run.id,
              text,
              parts: [{ type: "text", text }],
              sender: null,
              source: "local",
            },
          })
          if (!reply.success) throw new Error(reply.error)
          finish(run, { status: "succeeded", replyMessageId: reply.message.id, finishedAt: Date.now() })
        }
        if (onTurn) await onTurn(run, complete)
        else complete("Plano conferido")
      })
      return { success: true as const, run }
    },
    cancel: (id: string) => {
      const run = persistence.getRun(id)
      if (!run) return { success: false as const, errorCode: "NOT_FOUND" as const, error: "Missing run" }
      if (["queued", "starting", "running"].includes(run.status))
        finish(run, { status: "canceled", errorClass: "canceled", finishedAt: Date.now() })
      return { success: true as const, run }
    },
  }
  const runtime = createGroupRuntime(host.kernel, engine, undefined, 1)
  const runtimes = new Set([runtime])
  cleanups.add(async () => {
    runtimes.forEach((current) => {
      current.shutdown()
    })
    await Promise.all(Array.from(runtimes, (current) => current.waitForDrain()))
    await closeHost()
  })
  cleanups.delete(closeHost)
  const send = (text: string) => {
    const request = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: thread.id,
        parentId: store.getThread({ threadId: thread.id })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = runtime.enqueue({ threadId: thread.id, requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    return result.run
  }
  const restart = () => {
    const resumed = createGroupRuntime(host.kernel, engine, undefined, 1)
    runtimes.add(resumed)
    return resumed
  }
  return {
    root,
    host,
    db,
    store,
    bots,
    group,
    thread,
    data,
    persistence,
    runtime,
    send,
    order,
    engine,
    finish,
    restart,
  }
}

test("one channel mention starts one provider execution even if enqueue is repeated", async () => {
  const f = await fixture()
  const updates = new Set<Run>()
  const unsubscribe = f.host.kernel.subscribe(({ event }) => {
    if (event.type === "run.updated" && event.run.threadId === f.thread.id) updates.add({ ...event.run })
  })
  cleanups.add(async () => unsubscribe())

  const run = f.send("@Lia confira o plano")

  const repeated = f.runtime.enqueue({
    threadId: run.threadId,
    requestMessageId: run.requestMessageId ?? "",
    trigger: "user",
  })
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")

  expect(repeated.success && repeated.run.id).toBe(run.id)
  expect(f.order).toEqual([f.bots[0]?.id ?? ""])
  expect(run).toMatchObject({ kind: "coordination" })
  const history = f.runtime.listRuns(f.thread.id)
  expect(history).toHaveLength(2)
  expect(history.find((candidate) => candidate.id === run.id)).toMatchObject({ kind: "coordination" })
  expect(history.find((candidate) => candidate.id !== run.id)).toMatchObject({
    kind: "execution",
    groupTurnId: run.id,
  })
  const coordination = Array.from(updates).filter((candidate) => candidate.id === run.id)
  expect(coordination.map((candidate) => candidate.status)).toEqual(["queued", "running", "succeeded"])
  expect(coordination.every((candidate) => candidate.kind === "coordination")).toBe(true)
  const executions = Array.from(updates).filter((candidate) => candidate.id !== run.id)
  expect(executions.length).toBeGreaterThan(0)
  expect(executions.every((candidate) => candidate.kind === "execution" && candidate.groupTurnId === run.id)).toBe(true)
  expect(f.store.activePath({ threadId: f.thread.id }).filter((message) => message.role === "assistant")).toHaveLength(
    1,
  )
})

test.each(["channel", "direct"] as const)("%s send acknowledgements retain run kind across retries", async (target) => {
  const scenario = await fixture()
  scenario.host.kernel.services.provide("runtime.enqueue", scenario.runtime.enqueue)
  const direct =
    target === "direct"
      ? scenario.store.createThread({ botId: scenario.thread.botId, kind: "chat", title: "Conversa" })
      : null
  if (direct && !direct.success) throw new Error(direct.error)
  const threadId = direct?.success ? direct.thread.id : scenario.thread.id
  const sendMessage = scenario.store.sendMessage
  if (!sendMessage) throw new Error("Send journal missing")
  const input = {
    threadId,
    parentId: null,
    text: "@Lia confira o plano",
    attachmentIds: [],
    clientNonce: "synthetic-run-identity",
    deadline: Date.now() + 60_000,
  }

  const sent = sendMessage(input)
  const repeated = sendMessage(input)
  if (!("json" in sent)) throw new Error("Send acknowledgement missing")
  const { run } = sent.json as { run: Run }
  await until(() => scenario.persistence.getRun(run.id)?.status === "succeeded")
  const completed = sendMessage(input)

  expect(sent.status).toBe(201)
  expect(repeated.status).toBe(200)
  expect(completed.status).toBe(200)
  const kind = target === "channel" ? "coordination" : "execution"
  const acknowledgements = [sent, repeated, completed]
  acknowledgements.forEach((response) => {
    expect(response).toMatchObject({ json: { run: { id: run.id, threadId, kind } } })
  })
  expect(scenario.order).toEqual([scenario.thread.botId])
  const history = scenario.runtime.listRuns(threadId)
  expect(history).toHaveLength(target === "channel" ? 2 : 1)
  expect(history.filter((candidate) => candidate.kind === "execution")).toHaveLength(1)
})

test("a channel resumes a crashed provider twice then stops", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run) => {
    const previous = f.persistence.getRun(run.id)
    if (!previous) throw new Error("Missing fixture run")
    const failed: Run = { ...previous, status: "failed", errorClass: "cli_crash", finishedAt: Date.now() }
    f.persistence.saveRun(failed)
    f.host.kernel.publish({ type: "run.updated", run: failed })
  })

  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")

  expect(f.order).toHaveLength(3)
  expect(f.db.query("SELECT COUNT(*) AS count FROM run_continuations").get()).toEqual({ count: 2 })
})

test("a channel resumes its unfinished member after restart without repeating a completed member", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (_run, complete) => {
    if (f.order.length === 2) return
    complete("Plano conferido")
  })
  const run = f.send("@Lia @Bia confira o plano")
  await until(() => f.order.length === 2)
  f.runtime.shutdown({ appRestart: true })
  const activeMembers = f.db.query("SELECT run_id FROM group_run_links WHERE turn_id=?").all(run.id) as {
    run_id: string
  }[]
  activeMembers.forEach(({ run_id }) => {
    const member = f.persistence.getRun(run_id)
    if (member?.status === "running")
      f.finish(member, { status: "interrupted", errorClass: "app_restart", finishedAt: Date.now() })
  })
  await until(() => f.persistence.getRun(run.id)?.status === "interrupted")

  f.restart()
  await until(() =>
    f.persistence
      .listRuns(f.thread.id)
      .some((candidate) => candidate.id !== run.id && candidate.status === "succeeded"),
  )
  expect(f.persistence.getRun(run.id)?.status).toBe("interrupted")

  expect(f.order).toEqual([f.bots[0]?.id ?? "", f.bots[1]?.id ?? "", f.bots[1]?.id ?? ""])
  expect(
    f.store
      .activePath({ threadId: f.thread.id })
      .filter((message) => message.role === "assistant" && message.status === "complete"),
  ).toHaveLength(2)
})

test("pressing Stop prevents automatic channel recovery", async () => {
  const f = await fixture(async () => {})
  const run = f.send("@Lia confira o plano")
  await until(() => f.order.length === 1)

  f.runtime.cancel(run.id)
  await until(() => f.persistence.getRun(run.id)?.status === "canceled")

  expect(f.order).toHaveLength(1)
  expect(f.db.query("SELECT COUNT(*) AS count FROM run_continuations").get()).toEqual({ count: 0 })
})

test("a channel waiting for approval never resumes by itself", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run) => {
    const reply = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: run.threadId,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "approval",
        status: "failed",
        runId: run.id,
        text: "",
        parts: [
          {
            type: "approval",
            approvalId: "synthetic-approval",
            request: "permission",
            decision: "pending",
            detail: "Conferir o plano",
          },
        ],
        sender: null,
        source: "local",
      },
    })
    if (!reply.success) throw new Error(reply.error)
    f.finish(run, {
      status: "interrupted",
      errorClass: "app_restart",
      replyMessageId: reply.message.id,
      finishedAt: Date.now(),
    })
  })

  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")

  expect(f.order).toHaveLength(1)
  expect(f.db.query("SELECT COUNT(*) AS count FROM run_continuations").get()).toEqual({ count: 0 })
})

test("a recorded command stays in history and blocks automatic replay", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run, complete) => {
    if (f.order.length > 1) return complete("Plano conferido")
    const reply = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: run.threadId,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "failed",
        runId: run.id,
        text: "",
        parts: [
          {
            type: "command",
            callId: "observed-command",
            command: "echo conferido",
            cwd: "/workspace",
            exitCode: 0,
            outputTail: "conferido",
            resolution: "succeeded",
          },
        ],
        sender: null,
        source: "local",
      },
    })
    if (!reply.success) throw new Error(reply.error)
    f.finish(run, {
      status: "failed",
      errorClass: "cli_crash",
      replyMessageId: reply.message.id,
      finishedAt: Date.now(),
    })
  })

  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")

  expect(f.order).toHaveLength(1)
  expect(
    f.store
      .activePath({ threadId: f.thread.id })
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "command"),
  ).toHaveLength(1)
})

test("retrying an empty answer starts one new attempt and is idempotent", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run, complete) => {
    if (f.order.length > 1) return complete("Plano conferido")
    f.finish(run, {
      status: "failed",
      errorClass: "cli_protocol",
      errorMessage: "O bot terminou sem responder. Tente novamente.",
      finishedAt: Date.now(),
    })
  })
  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")

  const retry = f.runtime.retry(run.id)
  if (!retry?.success) throw new Error("Synthetic retry failed")
  await until(() => f.persistence.getRun(retry.run.id)?.status === "succeeded")

  expect(f.runtime.retry(run.id)).toMatchObject({ success: true, run: { id: retry.run.id } })
  expect(f.order).toHaveLength(2)
})

test("durable effects block automatic and explicit replay even without a reply part", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run) => {
    const work = createWorkState({ database: f.db })
    work.beginEffect({
      turnId: run.id,
      threadId: run.threadId,
      key: "synthetic-process",
      description: "Conferir o plano",
      effectId: "synthetic-effect",
    })
    work.recover({ observe: () => ({ kind: "unobservable", reason: "Synthetic interrupted process" }) })
    f.finish(run, { status: "failed", errorClass: "cli_crash", finishedAt: Date.now() })
  })

  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")
  const retry = f.runtime.retry(run.id)

  expect(f.order).toHaveLength(1)
  expect(retry).toMatchObject({ success: false, errorCode: "CONFLICT" })
  expect(f.db.query("SELECT COUNT(*) AS count FROM run_continuations").get()).toEqual({ count: 0 })
})

test("Stop while startup is waiting never starts a member when the engine becomes ready", async () => {
  const startup = Promise.withResolvers<void>()
  cleanups.add(async () => startup.resolve())
  const f = await fixture(undefined, startup.promise)
  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "running")

  f.runtime.cancel(run.id)
  startup.resolve()
  await f.runtime.waitForDrain()

  expect(f.persistence.getRun(run.id)?.status).toBe("canceled")
  expect(f.order).toHaveLength(0)
  expect(f.db.query("SELECT COUNT(*) AS count FROM group_run_links WHERE turn_id=?").get(run.id)).toEqual({ count: 0 })
})

test("a bot paused while startup is waiting cannot start when the engine becomes ready", async () => {
  const startup = Promise.withResolvers<void>()
  cleanups.add(async () => startup.resolve())
  const f = await fixture(undefined, startup.promise)
  const run = f.send("@Lia confira o plano")
  await until(() => f.persistence.getRun(run.id)?.status === "running")

  f.db.query("UPDATE bots SET paused=1 WHERE id=?").run(f.bots[0]?.id ?? "")
  startup.resolve()
  await f.runtime.waitForDrain()

  expect(f.persistence.getRun(run.id)?.status).toBe("failed")
  expect(f.order).toHaveLength(0)
})

const failureClasses = ["cli_protocol", "rate_limit", "cli_auth"] as const
failureClasses.forEach((errorClass) => {
  test(`coordination preserves the member failure class: ${errorClass}`, async () => {
    const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run) => {
      f.finish(run, {
        status: "failed",
        errorClass,
        errorMessage: "Synthetic provider failure",
        finishedAt: Date.now(),
      })
    })

    const run = f.send("@Lia confira o plano")
    await until(() => f.persistence.getRun(run.id)?.status === "failed")

    expect(f.persistence.getRun(run.id)).toMatchObject({
      errorClass,
      errorMessage: "Synthetic provider failure",
    })
    expect(f.order).toHaveLength(1)
  })
})

test("recovery keeps the member failure when automatic resume becomes disabled", async () => {
  const f: Awaited<ReturnType<typeof fixture>> = await fixture(async (run) => {
    if (f.order.length === 1) return

    f.finish(run, {
      status: "failed",
      errorClass: "cli_auth",
      errorMessage: "Unexpected synthetic retry",
      finishedAt: Date.now(),
    })
  })
  const run = f.send("@Lia confira o plano")
  await until(() => f.order.length === 1)
  f.runtime.shutdown({ appRestart: true })
  const memberId = f.runtime.listRuns(f.thread.id).find((candidate) => candidate.groupTurnId === run.id)?.id
  const member = memberId ? f.persistence.getRun(memberId) : null
  if (!member) throw new Error("Synthetic member missing")
  f.finish(member, {
    status: "failed",
    errorClass: "cli_crash",
    errorMessage: "Synthetic provider failure",
    finishedAt: Date.now(),
  })
  await f.runtime.waitForDrain()
  expect(f.persistence.getRun(run.id)?.status).toBe("interrupted")
  const unsubscribe = f.host.kernel.subscribe(({ event }) => {
    if (event.type !== "message.created") return
    if (!event.message.parts.some((part) => part.type === "notice" && part.code === "group_coordination_prompt")) return

    f.db
      .query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1)")
      .run()
  })
  cleanups.add(async () => unsubscribe())

  const resumed = f.restart()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await resumed.waitForDrain()

  expect(f.persistence.listRuns(f.thread.id).find((candidate) => candidate.id !== run.id)).toMatchObject({
    errorClass: "cli_crash",
    errorMessage: "Synthetic provider failure",
  })
  expect(f.order).toHaveLength(1)
  expect(f.persistence.getRun(run.id)?.status).toBe("interrupted")
})
