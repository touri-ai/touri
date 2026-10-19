import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderAdapter, Run } from "@touri/contracts"
import {
  botSessionPath,
  deletedBrowserSessionKey,
  loadBotSession,
  saveBotSession,
} from "../../src/browser/sessionVault"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { collectUnusedOutputBlobs } from "../../src/kernel/data-maintenance"
import { createEventBus } from "../../src/kernel/event-bus"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { deleteBotRoute } from "../../src/vm/delete-bot"
import { createVmRuntime } from "../../src/vm/runtime"
import { fakeVmProvider } from "./fake-provider"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const fixture = async ({
  callHost,
  collectBlobs,
}: {
  callHost?: Kernel["callHost"]
  collectBlobs?: typeof collectUnusedOutputBlobs
} = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-delete-bot-"))
  mkdirSync(join(root, ".codex"))
  writeFileSync(join(root, ".codex/auth.json"), JSON.stringify({ access_token: "fake-test-only" }))
  const runtime = createKernel({ appData: join(root, "data") })
  await initStore(runtime.kernel)
  const vault = new Map<string, string>()
  const sessionDeletions = new Map<string, { botExists: boolean; inTransaction: boolean }>()
  runtime.kernel.callHost =
    callHost ??
    ((async (method, params) => {
      const { account, value } = params as { account: string; value?: string }
      if (method === "keychain.get") return { success: true, value: { value: vault.get(account) ?? null } }
      if (method === "keychain.set" && value) vault.set(account, value)
      if (method === "keychain.delete") {
        vault.delete(account)
        if (account.startsWith("browser-session-key:")) {
          const botId = account.slice("browser-session-key:".length)
          const db = runtime.kernel.db as Database
          sessionDeletions.set(botId, {
            botExists: !!db.query("SELECT id FROM bots WHERE id = ?").get(botId),
            inTransaction: db.inTransaction,
          })
        }
      }
      return { success: true, value: {} }
    }) as typeof runtime.kernel.callHost)
  const fake = fakeVmProvider()
  const vm = createVmRuntime({
    kernel: runtime.kernel,
    provider: fake.provider,
    hostHome: root,
    capability: { available: true, reason: null, provider: "fake" },
    connectionKeys: { rotate: async () => Buffer.alloc(32), remove: async () => {} },
  })
  runtime.kernel.services.provide("vm.runtime", vm.service)
  runtime.kernel.registerRoutes({
    name: "delete-test",
    routes: [deleteBotRoute(runtime.kernel, vm.service, collectBlobs)],
  })
  const request = (path: string, body: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "delete-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  const create = async (name: string, machine = "vm") => {
    const response = await request("/bots", { name, provider: "codex", machine, vmProviderLogin: machine === "vm" })
    expect(response.status).toBe(201)
    return ((await response.json()) as { bot: Bot }).bot
  }
  cleanups.push(async () => {
    runtime.kernel.services.use("groups.runtime")?.shutdown()
    await runtime.kernel.services.use("runtime.shutdown")?.()
    await vm.dispose()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtime, db: runtime.kernel.db as Database, fake, vm, request, create, sessionDeletions }
}

const makeCleanupFixture = async (collectBlobs = collectUnusedOutputBlobs) => {
  const workspace = await fixture({ collectBlobs })
  workspace.runtime.kernel.services.use("storage.maintenance")?.dispose()
  const start = mock(() => true)
  workspace.runtime.kernel.services.provide("storage.maintenance", {
    start,
    scheduleSessionKeyRetry: () => {},
    snapshot: () => ({ running: false, processed: 0, total: 0 }),
    dispose: () => {},
  })
  const bot = await workspace.create("Private cleanup", "local")
  const path = join(workspace.runtime.kernel.paths.attachmentsDir, "cleanup-private.png")
  writeFileSync(path, "image")
  workspace.db
    .query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES ('cleanup-private',?,'image/png',5,1)")
    .run(path)
  workspace.db
    .query(
      "INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at) VALUES ('cleanup-files',?,'user','text','',?,1,1)",
    )
    .run(
      bot.mainThreadId ?? "",
      JSON.stringify([{ type: "image", attachmentId: "cleanup-private", mime: "image/png" }]),
    )
  const published = mock(() => {})
  workspace.runtime.kernel.subscribe(({ event }) => {
    if (event.type === "bot.deleted" && event.botId === bot.id) published()
  })

  return { workspace, bot, path, start, published }
}

const expectPendingCleanup = async (cleanup: Awaited<ReturnType<typeof makeCleanupFixture>>, response: Response) => {
  const { workspace, bot, path, start, published } = cleanup

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: "TOURI-E2015", origin: "bot-cleanup", retryable: false })
  expect(workspace.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
  expect(published).toHaveBeenCalledTimes(1)
  expect(existsSync(path)).toBe(true)
  expect(
    workspace.db.query("SELECT value_json FROM settings WHERE key = ?").get(`storage.deleted-attachments:${bot.id}`),
  ).toEqual({ value_json: JSON.stringify(["cleanup-private"]) })
  expect(start).toHaveBeenCalledTimes(1)
}

const makeGroupHistory = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const owner = await f.create("Group owner", "local")
  const participant = await f.create("Group participant", "local")
  const groups = createGroupStore(f.runtime.kernel)
  const group = groups.save({
    name: "Test group",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: [owner.id, participant.id],
    coordinatorBotId: owner.id,
  })
  const thread = groups.createThread(group)
  const child = groups.participant(group, thread.id, participant.id)
  f.db
    .query(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at) VALUES ('group-turn',?,?,'codex','user','succeeded',1,2), ('group-reply',?,?,'codex','user','succeeded',1,2)",
    )
    .run(thread.id, participant.id, child.id, participant.id)
  f.db.query("INSERT INTO group_turns VALUES ('group-turn',?,?)").run(group.id, JSON.stringify([participant.id]))
  f.db.query("INSERT INTO group_run_links VALUES ('group-reply','group-turn',0)").run()
  f.db
    .query(
      "INSERT INTO send_journal(thread_id,client_nonce,request_json,message_id,deadline,status,run_id,created_at,updated_at) VALUES (?,'group-nonce','{}','group-message',1,'acked','group-turn',1,1)",
    )
    .run(thread.id)
  f.db
    .query(
      "INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution) VALUES ('group-turn','group-call',?,?,'succeeded')",
    )
    .run(
      thread.id,
      JSON.stringify({
        type: "tool_call",
        callId: "group-call",
        tool: "history_read",
        summary: "Shared history",
        inputJson: "{}",
        outputJson: "{}",
        ok: true,
      }),
    )
  f.db
    .query(
      "INSERT INTO messages(id,thread_id,role,kind,run_id,text,created_at,updated_at) VALUES ('group-message',?,'user','text','group-turn','Shared conversation',1,1)",
    )
    .run(thread.id)
  f.db.query("INSERT INTO group_message_links VALUES ('reply',?,'visible-reply')").run(child.id)

  return { owner, participant, group, thread, child, groups }
}

const makeDeferredGroupEngine = (kernel: Kernel, runningBotId: string) => {
  const persistence = createRuntimePersistence({ database: kernel.db as Database })
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const started = Promise.withResolvers<Run>()
  const canceled = Promise.withResolvers<Run>()
  const released = Promise.withResolvers<void>()
  const completed = canceled.promise.then(async (run) => {
    await released.promise
    const finished: Run = { ...run, status: "canceled", errorClass: "canceled", finishedAt: Date.now() }
    persistence.saveRun(finished)
    kernel.publish({ type: "run.updated", run: finished })
    return finished
  })
  const cancel = (id: string) => {
    const run = persistence.getRun(id)
    if (!run) return { success: false as const, errorCode: "NOT_FOUND" as const, error: "Missing test run" }
    if (run.status === "running") canceled.resolve(run)
    return { success: true as const, run }
  }
  kernel.services.provide("runtime.shutdown", async () => {
    const active = persistence.listActiveRuns().filter((run) => run.botId === runningBotId)
    active.forEach((run) => {
      cancel(run.id)
    })
    released.resolve()
    if (active.length) await completed
  })
  const enqueue = ({ threadId, requestMessageId }: { threadId: string; requestMessageId: string }) => {
    const thread = store.getThread({ threadId })
    if (!thread)
      return { success: false as const, errorCode: "THREAD_NOT_FOUND" as const, error: "Missing test thread" }
    const running = thread.botId === runningBotId
    const run: Run = {
      id: kernel.newId(),
      threadId,
      botId: thread.botId,
      provider: "codex",
      trigger: "user",
      requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status: running ? "running" : "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: running ? null : Date.now(),
    }
    persistence.saveRun(run)
    if (running) started.resolve(run)
    return { success: true as const, run }
  }
  return { enqueue, cancel, started: started.promise, canceled: canceled.promise, completed, release: released.resolve }
}

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Live group turn did not settle")
}

const makeLiveGroup = async (
  workspace: Awaited<ReturnType<typeof fixture>>,
  history: Awaited<ReturnType<typeof makeGroupHistory>>,
) => {
  const kernel = workspace.runtime.kernel
  const signals = new Map<string, AbortSignal>()
  const threadSignals = new Map<string, AbortSignal>()
  const completions = new Map<string, () => void>()
  const provider = history.owner.provider
  const adapter: ProviderAdapter = {
    provider,
    detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
    startTurn: async ({ bot, thread, signal, onEvent }) => {
      const finish = Promise.withResolvers<void>()
      signals.set(bot.id, signal)
      threadSignals.set(thread.id, signal)
      completions.set(bot.id, finish.resolve)
      signal.addEventListener("abort", () => finish.resolve(), { once: true })
      onEvent({ type: "turn_started", externalTurnId: thread.id })
      if (!signal.aborted) await finish.promise
      if (signal.aborted) return { success: false, errorCode: "canceled", error: "Turno cancelado" }

      onEvent({ type: "text_delta", itemId: thread.id, delta: `Resultado de ${bot.name}` })
      return { success: true, externalSessionId: thread.id, rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const engine = createRuntimeEngine({
    kernel,
    providerAdapters: { [provider]: adapter },
    maxConcurrentRuns: 6,
    environment: { PATH: process.env.PATH ?? "" },
  })
  await engine.ready
  const groups = createGroupRuntime(kernel, engine)
  kernel.services.provide("groups.runtime", groups)
  kernel.services.provide("runtime.enqueue", groups.enqueue)
  kernel.services.provide("runtime.cancelBotTurns", groups.cancelBotTurns)
  kernel.services.provide("runtime.shutdown", async () => {
    groups.shutdown()
    await engine.shutdown()
    await Bun.sleep(0)
  })
  history.groups.save(
    { ...(history.groups.get(history.group.id) ?? history.group), coordinatorBotId: null },
    history.group,
  )
  const send = async (text: string, groupAction?: "ask_all", threadId = history.thread.id) => {
    const response = await workspace.request(`/threads/${threadId}/messages`, {
      text,
      attachmentIds: [],
      ...(groupAction ? { groupAction } : {}),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { run: Run }).run
  }

  return {
    groups,
    signals,
    threadSignals,
    persistence: createRuntimePersistence({ database: workspace.db }),
    send,
    complete: (botId: string) => completions.get(botId)?.(),
  }
}

const groupMembers = ["owner", "participant"] as const
groupMembers.forEach((member) => {
  test(`deleting an idle group ${member} preserves the shared conversation and clears cross-thread run references`, async () => {
    const f = await fixture()
    const history = await makeGroupHistory(f)
    const bot = history[member]
    const remaining = member === "owner" ? history.participant : history.owner

    const response = await f.request(`/bots/${bot.id}`, { name: bot.name, deleteVolumes: true }, "DELETE")

    expect(response.status).toBe(200)
    expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
    expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(remaining.id)).not.toBeNull()
    expect(f.db.query("SELECT id FROM threads WHERE id = ?").get(bot.mainThreadId ?? "")).toBeNull()
    expect(f.db.query("SELECT bot_id FROM threads WHERE id = ?").get(history.thread.id)).toEqual({
      bot_id: remaining.id,
    })
    expect(f.db.query("SELECT text FROM messages WHERE thread_id = ?").get(history.thread.id)).toEqual({
      text: "Shared conversation",
    })
    expect(f.db.query("SELECT status, run_id FROM send_journal WHERE thread_id = ?").get(history.thread.id)).toEqual({
      status: "acked",
      run_id: member === "participant" ? null : "group-turn",
    })
    expect(history.groups.get(history.group.id)?.memberIds).toEqual([remaining.id])
    expect(history.groups.get(history.group.id)?.coordinatorBotId).toBe(member === "owner" ? null : remaining.id)
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
  })
})

test("deleting the last group member clears runs owned by a former member on its shared thread", async () => {
  const f = await fixture()
  const history = await makeGroupHistory(f)
  f.db
    .query("DELETE FROM group_members WHERE group_id = ? AND bot_id = ?")
    .run(history.group.id, history.participant.id)

  const response = await f.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(f.db.query("SELECT id FROM threads WHERE id = ?").get(history.thread.id)).toBeNull()
  expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(history.participant.id)).not.toBeNull()
  expect(f.db.query("SELECT group_thread_id FROM threads WHERE id = ?").get(history.child.id)).toEqual({
    group_thread_id: null,
  })
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("deleting an idle group member waits for another member's child and the aggregate turn to stop", async () => {
  const f = await fixture()
  const history = await makeGroupHistory(f)
  const group = history.groups.save({ ...history.group, coordinatorBotId: null }, history.group)
  const engine = makeDeferredGroupEngine(f.runtime.kernel, history.participant.id)
  const groups = createGroupRuntime(f.runtime.kernel, engine)
  f.runtime.kernel.services.provide("groups.runtime", groups)
  f.runtime.kernel.services.provide("runtime.cancelBotTurns", groups.cancelBotTurns)
  const turn = groups.enqueue({ threadId: history.thread.id, requestMessageId: "group-message", trigger: "user" })
  if (!turn.success) throw new Error("Could not enqueue test group turn")
  const child = await engine.started
  const settled = Promise.withResolvers<Run>()
  const unsubscribe = f.runtime.kernel.subscribe(({ event }) => {
    if (event.type !== "run.updated" || event.run.id !== turn.run.id || event.run.status !== "canceled") return

    unsubscribe()
    settled.resolve(event.run)
  })
  expect(turn.run.botId).toBe(history.owner.id)
  expect(child.botId).toBe(history.participant.id)
  expect(group.memberIds).toEqual([history.owner.id, history.participant.id])

  const deletion = f.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")
  await Promise.race([
    engine.canceled,
    deletion.then(() => {
      throw new Error("Deletion completed before canceling the active group child")
    }),
  ])
  expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(history.owner.id)).not.toBeNull()
  expect(f.db.query("SELECT status FROM runs WHERE id = ?").get(child.id)).toEqual({ status: "running" })
  expect(f.db.query("SELECT status FROM runs WHERE id = ?").get(turn.run.id)).toEqual({ status: "running" })
  engine.release()
  const response = await deletion

  expect(response.status).toBe(200)
  expect((await engine.completed).status).toBe("canceled")
  expect((await settled.promise).status).toBe("canceled")
  expect(f.db.query("SELECT id FROM runs WHERE id = ?").get(turn.run.id)).toBeNull()
  expect(f.db.query("SELECT status FROM runs WHERE id = ?").get(child.id)).toEqual({ status: "canceled" })
  expect(f.db.query("SELECT bot_id FROM threads WHERE id = ?").get(history.thread.id)).toEqual({
    bot_id: history.participant.id,
  })
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("deleting an idle member preserves another member's live turn and queued turn in the same group", async () => {
  const f = await fixture()
  const history = await makeGroupHistory(f)
  const live = await makeLiveGroup(f, history)
  const turn = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))
  const queued = await live.send(`@"${history.participant.name}" continue`)
  const removed = await live.send(`@"${history.owner.name}" revise`)

  const response = await f.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")
  const signal = live.signals.get(history.participant.id)
  expect(signal?.aborted).toBe(false)
  expect(live.persistence.getRun(turn.id)?.status).toBe("running")
  expect(live.persistence.getRun(queued.id)?.status).toBe("queued")
  expect(live.persistence.getRun(removed.id)).toBeNull()
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")
  await until(() => live.signals.get(history.participant.id) !== signal)
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(queued.id)?.status === "succeeded")

  expect(response.status).toBe(200)
  expect(live.groups.listRuns(history.thread.id).filter((run) => run.status === "succeeded")).toHaveLength(6)
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("the bot deletion event preserves another member's live turn", async () => {
  const workspace = await fixture()
  const history = await makeGroupHistory(workspace)
  const live = await makeLiveGroup(workspace, history)
  const turn = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))

  workspace.runtime.kernel.publish({ type: "bot.deleted", botId: history.owner.id })
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")

  expect(live.signals.get(history.participant.id)?.aborted).toBe(false)
})

test.each(groupMembers)(
  "deleting the ask-all %s cancels only its live run and preserves the other results",
  async (member) => {
    const workspace = await fixture()
    const history = await makeGroupHistory(workspace)
    const third = await workspace.create("Third member", "local")
    history.groups.save({ ...history.group, memberIds: [...history.group.memberIds, third.id] }, history.group)
    const live = await makeLiveGroup(workspace, history)
    const bot = history[member]
    const turn = await live.send("Revisem o plano", "ask_all")
    await until(() => live.signals.size === 3)
    const members = live.groups.listRuns(history.thread.id).filter((run) => run.groupTurnId === turn.id)
    const removed = members.find((run) => run.botId === bot.id)
    const remaining = members.filter((run) => run.botId !== bot.id)
    if (!removed) throw new Error("Missing member run")
    const canceled = new Set<string>()
    const unsubscribe = workspace.runtime.kernel.subscribe(({ event }) => {
      if (event.type === "run.updated" && event.run.status === "canceled") canceled.add(event.run.id)
    })

    const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
    unsubscribe()

    expect(response.status).toBe(200)
    expect(canceled.has(removed.id)).toBe(true)
    expect(remaining.every((run) => !live.signals.get(run.botId)?.aborted)).toBe(true)
    expect(live.persistence.getRun(turn.id)?.status).toBe("running")
    expect(live.persistence.getRun(turn.id)?.botId).not.toBe(bot.id)
    remaining.forEach((run) => {
      live.complete(run.botId)
    })
    await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")

    const results = live.groups.listRuns(history.thread.id).filter((run) => run.groupTurnId === turn.id)
    expect(results).toHaveLength(2)
    expect(results.every((run) => run.status === "succeeded")).toBe(true)
    const messages =
      workspace.runtime.kernel.services.use("store.api")?.activePath({ threadId: history.thread.id }) ?? []
    expect(messages.filter((message) => message.role === "assistant" && message.status === "complete")).toHaveLength(2)
    expect(
      messages.find((message) =>
        message.parts.some((part) => part.type === "notice" && part.code === "group_member_removed"),
      ),
    ).toMatchObject({ runId: turn.id, sender: { id: bot.id, name: bot.name } })
    expect(workspace.db.query("PRAGMA foreign_key_check").all()).toEqual([])
  },
)

test("deleting the shared thread's last member stops its live child while preserving the child's private turn", async () => {
  const workspace = await fixture()
  const history = await makeGroupHistory(workspace)
  const live = await makeLiveGroup(workspace, history)
  const turn = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))
  const groupSignal = live.signals.get(history.participant.id)
  history.groups.save({ ...history.group, memberIds: [history.owner.id] }, history.group)
  const privateTurn = await live.send("Conversa privada", undefined, history.participant.mainThreadId ?? "")
  await until(() => live.threadSignals.has(history.participant.mainThreadId ?? ""))
  const privateSignal = live.threadSignals.get(history.participant.mainThreadId ?? "")

  const response = await workspace.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(groupSignal?.aborted).toBe(true)
  expect(privateSignal?.aborted).toBe(false)
  expect(live.persistence.getRun(turn.id)).toBeNull()
  expect(live.persistence.getRun(privateTurn.id)?.status).toBe("running")
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(privateTurn.id)?.status === "succeeded")
  expect(workspace.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("deleting a queued ask-all recipient records removal before the surviving member starts", async () => {
  const workspace = await fixture()
  const history = await makeGroupHistory(workspace)
  const live = await makeLiveGroup(workspace, history)
  const active = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))
  const activeSignal = live.signals.get(history.participant.id)
  const queued = await live.send("Revisem o plano", "ask_all")

  const response = await workspace.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(live.persistence.getRun(queued.id)?.status).toBe("queued")
  expect(activeSignal?.aborted).toBe(false)
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(active.id)?.status === "succeeded")
  await until(() => live.signals.get(history.participant.id) !== activeSignal)
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(queued.id)?.status === "succeeded")
  const messages = workspace.runtime.kernel.services.use("store.api")?.activePath({ threadId: history.thread.id }) ?? []
  expect(messages.some((message) => message.runId === queued.id && message.sender?.id === history.owner.id)).toBe(true)
})

test("deleting a completed ask-all owner preserves the other member's confirmed result links", async () => {
  const workspace = await fixture()
  const history = await makeGroupHistory(workspace)
  const live = await makeLiveGroup(workspace, history)
  const turn = await live.send("Revisem o plano", "ask_all")
  await until(() => live.signals.size === 2)
  live.complete(history.owner.id)
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")

  const response = await workspace.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(live.persistence.getRun(turn.id)).toMatchObject({ status: "succeeded", botId: history.participant.id })
  expect(live.groups.listRuns(history.thread.id).filter((run) => run.groupTurnId === turn.id)).toEqual([
    expect.objectContaining({ botId: history.participant.id, status: "succeeded" }),
  ])
  expect(workspace.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("saved browser session cleanup runs after commit while a peer's live turn continues", async () => {
  const workspace = await fixture()
  const history = await makeGroupHistory(workspace)
  const live = await makeLiveGroup(workspace, history)
  const session = { cookies: [{ name: "sid", value: "fake", domain: "example.com", path: "/" }], storage: {} }
  expect(await saveBotSession({ kernel: workspace.runtime.kernel, botId: history.owner.id, session })).toBe(true)
  const turn = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))

  const response = await workspace.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")

  expect(response.status).toBe(200)
  expect(workspace.sessionDeletions.get(history.owner.id)).toEqual({ botExists: false, inTransaction: false })
  expect(existsSync(botSessionPath(workspace.runtime.kernel, history.owner.id))).toBe(false)
})

test("a failed browser session key deletion keeps the bot deletion successful and retries later", async () => {
  const hostState: { failBrowserKeyDelete: boolean; browserKey: string | null; browserKeyDeleteCalls: number } = {
    failBrowserKeyDelete: true,
    browserKey: null,
    browserKeyDeleteCalls: 0,
  }
  const workspace = await fixture({
    callHost: (async (method, params) => {
      const { account, value } = params as { account: string; value?: string }
      if (method === "keychain.get") return { success: true, value: { value: hostState.browserKey } }
      if (method === "keychain.set" && value) {
        hostState.browserKey = value
        return { success: true, value: {} }
      }
      if (method === "keychain.delete" && account.startsWith("browser-session-key:")) {
        hostState.browserKeyDeleteCalls += 1
        if (hostState.failBrowserKeyDelete)
          return { success: false, errorCode: "HOST_ERROR", error: "fake keychain failure" }
        hostState.browserKey = null
      }
      return { success: true, value: {} }
    }) as Kernel["callHost"],
  })
  const bot = await workspace.create("Session cleanup", "local")
  const session = { cookies: [{ name: "sid", value: "fake", domain: "example.com", path: "/" }], storage: {} }
  expect(await saveBotSession({ kernel: workspace.runtime.kernel, botId: bot.id, session })).toBe(true)
  const file = botSessionPath(workspace.runtime.kernel, bot.id)
  const events = new Set<string>()
  const unsubscribe = workspace.runtime.kernel.subscribe(({ event }) => {
    if (event.type === "bot.deleted" && event.botId === bot.id) events.add("bot.deleted")
    if (event.type === "transcript.resync") events.add("transcript.resync")
  })

  const maintenance = workspace.runtime.kernel.services.use("storage.maintenance")
  if (!maintenance) throw new Error("Storage maintenance missing")
  await until(() => !maintenance.snapshot().running)
  const start = mock(maintenance.start)
  workspace.runtime.kernel.services.provide("storage.maintenance", { ...maintenance, start })

  const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  unsubscribe()

  expect(response.status).toBe(200)
  expect(workspace.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
  expect(events).toEqual(new Set(["bot.deleted", "transcript.resync"]))
  expect(existsSync(file)).toBe(false)
  expect(hostState.browserKey).not.toBeNull()
  expect(workspace.db.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(bot.id))).toEqual({
    key: deletedBrowserSessionKey(bot.id),
  })

  await until(() => hostState.browserKeyDeleteCalls >= 2)
  expect(start).not.toHaveBeenCalled()
  expect(
    workspace.db.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(bot.id)),
  ).not.toBeNull()

  hostState.failBrowserKeyDelete = false
  maintenance.scheduleSessionKeyRetry()
  await until(() => !workspace.db.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(bot.id)))

  expect(hostState.browserKey).toBeNull()
  expect(workspace.db.query("SELECT key FROM settings WHERE key = ?").get(deletedBrowserSessionKey(bot.id))).toBeNull()
})

test("a malformed unrelated blob marker does not block bot deletion or shared group turns", async () => {
  const f = await fixture()
  const history = await makeGroupHistory(f)
  const live = await makeLiveGroup(f, history)
  const turn = await live.send(`@"${history.participant.name}" revise`)
  await until(() => live.signals.has(history.participant.id))
  f.db
    .query("INSERT INTO settings(key,value_json,updated_at) VALUES ('storage.deleted-attachments:broken','{',1)")
    .run()

  const response = await f.request(`/bots/${history.owner.id}`, { name: history.owner.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(history.owner.id)).toBeNull()
  expect(
    f.db.query("SELECT key FROM settings WHERE key = ?").get(`storage.deleted-attachments:${history.owner.id}`),
  ).toBeNull()
  expect(f.db.query("SELECT key FROM settings WHERE key = 'storage.deleted-attachments:broken'").get()).toEqual({
    key: "storage.deleted-attachments:broken",
  })
  expect(live.signals.get(history.participant.id)?.aborted).toBe(false)
  live.complete(history.participant.id)
  await until(() => live.persistence.getRun(turn.id)?.status === "succeeded")
})

test("deleting a bot switched from a virtual machine to local removes its retained machine and volumes", async () => {
  const f = await fixture()
  const bot = await f.create("Switched machine")
  const release = await f.vm.service.acquire({ botId: bot.id })
  await release()
  const switched = await f.request(`/bots/${bot.id}`, { machine: "local" }, "PATCH")
  expect(switched.status).toBe(200)
  expect(f.db.query("SELECT bot_id FROM bot_machines WHERE bot_id = ?").get(bot.id)).not.toBeNull()

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name, deleteVolumes: true }, "DELETE")

  expect(response.status).toBe(200)
  expect(f.db.query("SELECT bot_id FROM bot_machines WHERE bot_id = ?").get(bot.id)).toBeNull()
  expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
  expect(f.fake.machines.size).toBe(0)
  expect(f.fake.volumes.size).toBe(0)
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("deletion cancels bot tasks before stopping and removing its machine and volumes", async () => {
  const f = await fixture()
  const bot = await f.create("Machine tasks")
  const release = await f.vm.service.acquire({ botId: bot.id })
  f.runtime.kernel.services.provide("runtime.cancelBotTurns", release)

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name, deleteVolumes: true }, "DELETE")

  expect(response.status).toBe(200)
  expect(
    f.fake.calls.filter((call) => ["stop", "destroy", "deleteVolume"].includes(call.action)).map((call) => call.action),
  ).toEqual(["stop", "destroy", "deleteVolume", "deleteVolume"])
  expect(f.fake.machines.size).toBe(0)
  expect(f.fake.volumes.size).toBe(0)
})

test("an active machine lease explains the blocker and permits retry after release", async () => {
  const f = await fixture()
  const bot = await f.create("Machine in use")
  const release = await f.vm.service.acquire({ botId: bot.id })

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  await release()
  const retry = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: "TOURI-E8004",
    error: "O computador do bot ainda está em uso. Pare as tarefas e tente excluir novamente.",
  })
  expect(retry.status).toBe(200)
})

test("failed task cancellation identifies the blocker without exposing diagnostics", async () => {
  const f = await fixture()
  const bot = await f.create("Task failure", "local")
  f.runtime.kernel.services.provide("runtime.cancelBotTurns", async () => {
    throw new Error("private task diagnostic")
  })

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  const body = await response.json()

  expect(response.status).toBe(409)
  expect(body).toMatchObject({ code: "TOURI-E1015", origin: "bot-stop" })
  expect(JSON.stringify(body)).not.toContain("private task diagnostic")
  expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: bot.id })?.paused).toBe(false)
  expect(existsSync(bot.homeDir)).toBe(true)
})

test("a locked credential vault identifies the blocker and preserves bot history", async () => {
  const f = await fixture({
    callHost: async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "private vault diagnostic" }),
  })
  const bot = await f.create("Vault failure", "local")

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  const body = await response.json()

  expect(response.status).toBe(409)
  expect(body).toMatchObject({ code: "TOURI-E1016", origin: "bot-credentials" })
  expect(JSON.stringify(body)).not.toContain("private vault diagnostic")
  expect(f.db.query("SELECT id FROM threads WHERE bot_id = ?").all(bot.id)).toHaveLength(1)
  expect(existsSync(bot.homeDir)).toBe(true)
})

test("concurrent deletion explains that deletion is already in progress", async () => {
  const f = await fixture()
  const bot = await f.create("Concurrent deletion", "local")
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  f.runtime.kernel.services.provide("runtime.cancelBotTurns", async () => {
    started.resolve()
    await stopped.promise
  })

  const first = f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  await started.promise
  const duplicate = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  stopped.resolve()
  const completed = await first

  expect(duplicate.status).toBe(409)
  expect(await duplicate.json()).toMatchObject({ code: "TOURI-E1014", origin: "bot-deletion" })
  expect(completed.status).toBe(200)
})

test("A10 deletion purges replay copies, advances its floor and forces resync", async () => {
  const f = await fixture()
  const bot = await f.create("Replay", "local")
  const threadId = bot.mainThreadId ?? ""
  f.runtime.kernel.publish({
    type: "message.delta",
    threadId,
    messageId: "deleted-message",
    partIndex: 0,
    delta: "deleted-private-text",
  })
  const seq = (f.db.query("SELECT MAX(seq) AS seq FROM ui_event_log").get() as { seq: number }).seq
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(f.db.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%deleted-private-text%'").all()).toHaveLength(
    0,
  )
  expect(
    Number(
      (f.db.query("SELECT value FROM schema_meta WHERE key='ui_event_floor_seq'").get() as { value: string }).value,
    ),
  ).toBeGreaterThanOrEqual(seq)
  const bus = createEventBus(f.db)
  expect(bus.replay(0)[0]?.event.type).toBe("transcript.resync")
  bus.stop()
})

test("A10 deletion purges bot-owned VM process logs from replay", async () => {
  const f = await fixture()
  const bot = await f.create("Process", "local")
  f.db.exec(
    "INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('project','project','/synthetic/project','/synthetic/data',1,1)",
  )
  f.db
    .query(
      "INSERT INTO processes(id,project_id,name,command,cwd,vm_bot_id,created_by,created_at,updated_at) VALUES ('process','project','process','test','/workspace',?,'user',1,1)",
    )
    .run(bot.id)
  f.runtime.kernel.publish({ type: "process.log", processId: "process", lines: ["deleted-process-private-text"] })
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(
    f.db.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%deleted-process-private-text%'").all(),
  ).toHaveLength(0)
})

test("A10 deletion purges browser request origins associated through owned tabs", async () => {
  const f = await fixture()
  const bot = await f.create("Browser", "local")
  f.db
    .query(
      "INSERT INTO browser_tabs(id,owner_bot_id,url,state,created_at,last_used_at) VALUES ('tab',?,'https://private-origin.invalid','live',1,1)",
    )
    .run(bot.id)
  f.runtime.kernel.publish({
    type: "browser.secret_requested",
    requestId: "request",
    tabId: "tab",
    origin: "https://private-origin.invalid",
    fieldKinds: ["password"],
  })
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(
    f.db.query("SELECT seq FROM ui_event_log WHERE event_json LIKE '%private-origin.invalid%'").all(),
  ).toHaveLength(0)
})

test("A11 deletion removes host artifacts and login vault entries but retains shared attachments and projects", async () => {
  const f = await fixture()
  const bot = await f.create("Artifacts", "local")
  const other = await f.create("Other", "local")
  const deletedAccounts: string[] = []
  f.runtime.kernel.callHost = (async (method, params) => {
    if (method === "keychain.delete") deletedAccounts.push((params as { account: string }).account)
    return { success: true, value: {} }
  }) as typeof f.runtime.kernel.callHost
  const directory = join(f.runtime.kernel.paths.runDir, "claude")
  mkdirSync(directory, { recursive: true })
  const config = join(directory, `${bot.mainThreadId}.settings.json`)
  writeFileSync(config, "private config")
  writeFileSync(join(bot.homeDir, "MEMORY.md"), "private memory")
  const privateAttachment = join(f.runtime.kernel.paths.attachmentsDir, "private.png")
  const sharedAttachment = join(f.runtime.kernel.paths.attachmentsDir, "shared.png")
  for (const [id, path] of [
    ["private", privateAttachment],
    ["shared", sharedAttachment],
  ] as const) {
    writeFileSync(path, "image")
    f.db.query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,?,'image/png',5,1)").run(id, path)
  }
  for (const [current, ids] of [
    [bot, ["private", "shared"]],
    [other, ["shared"]],
  ] as const)
    f.db
      .query(
        "INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at) VALUES (?,?, 'user','text','',?,1,1)",
      )
      .run(
        `files-${current.id}`,
        current.mainThreadId ?? "",
        JSON.stringify(ids.map((attachmentId) => ({ type: "image", attachmentId, mime: "image/png" }))),
      )
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(existsSync(privateAttachment)).toBe(false)
  expect(f.db.query("SELECT id FROM attachments WHERE id='private'").get()).toBeNull()
  expect(existsSync(sharedAttachment)).toBe(true)
  expect(existsSync(bot.homeDir)).toBe(false)
  expect(existsSync(config)).toBe(false)
  expect(existsSync(other.homeDir)).toBe(true)
  expect(deletedAccounts).toEqual([
    `bot/${bot.id}/claude-vm-login`,
    `bot/${bot.id}/codex-vm-login`,
    `browser-session-key:${bot.id}`,
  ])
})

test("bot deletion waits for a deferred attachment cleanup under slow IO", async () => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let calls = 0
  const collectBlobs: typeof collectUnusedOutputBlobs = async (
    database,
    appData,
    now,
    yieldBatch,
    deletedBotAttachments,
    runStage,
    onDeferred,
    signal,
    attachmentReferenceTimeoutMs,
  ) => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await resume.promise
      onDeferred?.("changed")
      return 0
    }

    return collectUnusedOutputBlobs(
      database,
      appData,
      now,
      yieldBatch,
      deletedBotAttachments,
      runStage,
      onDeferred,
      signal,
      attachmentReferenceTimeoutMs,
    )
  }
  const f = await fixture({ collectBlobs })
  const bot = await f.create("Slow cleanup", "local")
  const other = await f.create("Shared cleanup", "local")
  const privateAttachment = join(f.runtime.kernel.paths.attachmentsDir, "slow-private.png")
  const sharedAttachment = join(f.runtime.kernel.paths.attachmentsDir, "slow-shared.png")
  writeFileSync(privateAttachment, "image")
  writeFileSync(sharedAttachment, "image")
  for (const [id, path] of [
    ["slow-private", privateAttachment],
    ["slow-shared", sharedAttachment],
  ] as const) {
    f.db.query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,?,'image/png',5,1)").run(id, path)
  }
  for (const [current, ids] of [
    [bot, ["slow-private", "slow-shared"]],
    [other, ["slow-shared"]],
  ] as const) {
    f.db
      .query(
        "INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at) VALUES (?,?, 'user','text','',?,1,1)",
      )
      .run(
        `slow-files-${current.id}`,
        current.mainThreadId ?? "",
        JSON.stringify(ids.map((attachmentId) => ({ type: "image", attachmentId, mime: "image/png" }))),
      )
  }

  let responseReceived = false
  const deletion = f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE").then((response) => {
    responseReceived = true
    return response
  })
  await entered.promise
  const responseArrivedDuringSlowIo = responseReceived
  resume.resolve()
  const response = await deletion

  expect(responseArrivedDuringSlowIo).toBe(false)
  expect(response.status).toBe(200)
  expect(calls).toBe(2)
  expect(existsSync(privateAttachment)).toBe(false)
  expect(f.db.query("SELECT id FROM attachments WHERE id='slow-private'").get()).toBeNull()
  expect(existsSync(sharedAttachment)).toBe(true)
  expect(f.db.query("SELECT id FROM attachments WHERE id='slow-shared'").get()).toEqual({ id: "slow-shared" })
})

test("sustained attachment deferrals stop after three passes with exponential backoff", async () => {
  const recordAttempt = mock((time: number) => time)
  const collectBlobs: typeof collectUnusedOutputBlobs = async (
    _database,
    _appData,
    _now,
    _yieldBatch,
    _attachments,
    _runStage,
    onDeferred,
  ) => {
    recordAttempt(performance.now())
    onDeferred?.("changed")
    return 0
  }
  const cleanup = await makeCleanupFixture(collectBlobs)
  const { workspace, bot } = cleanup

  const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")

  await expectPendingCleanup(cleanup, response)
  expect(recordAttempt).toHaveBeenCalledTimes(3)
  const [first = 0, second = 0, third = 0] = recordAttempt.mock.calls.map(([time]) => time)
  expect(second - first).toBeGreaterThanOrEqual(950)
  expect(third - second).toBeGreaterThanOrEqual(1950)
}, 10_000)

test("an attachment collection exception reports deletion with cleanup pending and restarts maintenance", async () => {
  const collectBlobs = mock(async () => {
    throw new Error("private cleanup diagnostic")
  })
  const cleanup = await makeCleanupFixture(collectBlobs)
  const { workspace, bot } = cleanup

  const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")

  await expectPendingCleanup(cleanup, response)
  expect(collectBlobs).toHaveBeenCalledTimes(1)
})

test("a pending storage upgrade reports deferred cleanup without starting a collection pass", async () => {
  const collectBlobs = mock(collectUnusedOutputBlobs)
  const cleanup = await makeCleanupFixture(collectBlobs)
  const { workspace, bot } = cleanup
  workspace.db
    .query("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('storage_upgrade_22',?)")
    .run(JSON.stringify({ cursor: 0, total: 1, backup: false }))

  const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")

  await expectPendingCleanup(cleanup, response)
  expect(collectBlobs).not.toHaveBeenCalled()
  const deferred = mock(() => {})
  expect(
    await collectUnusedOutputBlobs(
      workspace.db,
      workspace.runtime.kernel.paths.appData,
      Date.now(),
      undefined,
      undefined,
      undefined,
      deferred,
    ),
  ).toBe(0)
  expect(deferred).toHaveBeenCalledWith("changed")
})

test("a completed deletion intentionally retains private attachments pinned by a backup", async () => {
  const cleanup = await makeCleanupFixture()
  const { workspace, bot, path, start } = cleanup
  workspace.db.query("INSERT INTO storage_backup_attachments(attachment_id) VALUES ('cleanup-private')").run()

  const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")

  expect(response.status).toBe(200)
  expect(workspace.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
  expect(existsSync(path)).toBe(true)
  expect(workspace.db.query("SELECT id FROM attachments WHERE id = 'cleanup-private'").get()).not.toBeNull()
  expect(
    workspace.db.query("SELECT key FROM settings WHERE key = ?").get(`storage.deleted-attachments:${bot.id}`),
  ).toBeNull()
  expect(start).not.toHaveBeenCalled()
})

test("A11 deleting a symlinked bot home preserves the shared project target", async () => {
  const f = await fixture()
  const bot = await f.create("Linked home", "local")
  const shared = join(f.root, "shared-project")
  mkdirSync(shared)
  writeFileSync(join(shared, "keep.txt"), "shared")
  rmSync(bot.homeDir, { recursive: true })
  symlinkSync(shared, bot.homeDir)
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(existsSync(join(shared, "keep.txt"))).toBe(true)
  expect(existsSync(bot.homeDir)).toBe(false)
})

test("A11 vault failure keeps bot metadata and files available for a deletion retry", async () => {
  const f = await fixture()
  const bot = await f.create("Vault failure")
  await (await f.vm.service.acquire({ botId: bot.id }))()
  f.runtime.kernel.callHost = async () => ({
    success: false,
    errorCode: "HOST_UNAVAILABLE",
    error: "test vault unavailable",
  })
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(409)
  expect(existsSync(bot.homeDir)).toBe(true)
  expect(f.db.query("SELECT id FROM bots WHERE id=?").get(bot.id)).not.toBeNull()
  expect(f.fake.calls.filter((call) => call.action === "destroy")).toHaveLength(0)
})

for (const deleteVolumes of [false, true])
  test(`deleting only the named bot cleans its machine, conversations and schedules; deleteVolumes=${deleteVolumes}`, async () => {
    const f = await fixture()
    const bot = await f.create("Excluir")
    const other = await f.create("Preservar")
    await (await f.vm.service.acquire({ botId: bot.id }))()
    await (await f.vm.service.acquire({ botId: other.id }))()
    const volumes = [...f.fake.volumes]
    const machines = [...f.fake.machines.keys()]
    for (const current of [bot, other]) {
      expect((await f.request("/threads", { botId: current.id })).status).toBe(201)
      f.db
        .query(
          "INSERT INTO routines(id,bot_id,name,prompt,cron,timezone,created_at,updated_at) VALUES (?,?,'rotina','x','0 * * * *','UTC',1,1)",
        )
        .run(`routine-${current.id}`, current.id)
      // Use the application write path so transcript and FTS rows exist before
      // deletion, independently of the startup legacy-backfill timer.
      expect(
        f.runtime.kernel.services.use("store.api")?.insertMessage({
          message: {
            id: `message-${current.id}`,
            threadId: current.mainThreadId ?? "",
            parentId: null,
            role: "user",
            kind: "text",
            status: "complete",
            runId: null,
            text: "unique searchable",
            parts: [{ type: "text", text: "unique searchable" }],
            sender: null,
            source: "local",
          },
        }).success,
      ).toBe(true)
    }
    const retainedFile = join(f.root, "shared-project", "keep.txt")
    mkdirSync(join(f.root, "shared-project"))
    writeFileSync(retainedFile, "shared data")
    expect((await f.request(`/bots/${bot.id}`, { name: "errado", deleteVolumes: true }, "DELETE")).status).toBe(400)
    expect(f.fake.calls.filter((call) => call.action === "destroy")).toHaveLength(0)
    let canceled = ""
    f.runtime.kernel.services.provide("runtime.cancelBotTurns", async ({ botId }) => {
      canceled = botId
    })
    const response = await f.request(`/bots/${bot.id}`, { name: bot.name, deleteVolumes }, "DELETE")
    expect(response.status).toBe(200)
    expect(canceled).toBe(bot.id)
    expect(f.fake.machines.has(machines[0] ?? "")).toBe(false)
    expect(f.fake.machines.has(machines[1] ?? "")).toBe(true)
    expect(f.fake.volumes.has(volumes[0] ?? "")).toBe(!deleteVolumes)
    expect(f.fake.volumes.has(volumes[1] ?? "")).toBe(!deleteVolumes)
    expect(f.fake.volumes.has(volumes[2] ?? "")).toBe(true)
    expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toBeNull()
    expect(f.db.query("SELECT id FROM bots WHERE id = ?").get(other.id)).not.toBeNull()
    for (const table of ["threads", "routines"]) {
      expect(f.db.query(`SELECT id FROM ${table} WHERE bot_id = ?`).all(bot.id)).toHaveLength(0)
      expect(f.db.query(`SELECT id FROM ${table} WHERE bot_id = ?`).all(other.id).length).toBeGreaterThan(0)
    }
    expect(
      f.db.query("SELECT message_id FROM messages_fts WHERE thread_id = ?").all(bot.mainThreadId ?? ""),
    ).toHaveLength(0)
    expect(
      f.db.query("SELECT id FROM transcript_entries WHERE thread_id = ?").all(other.mainThreadId ?? "").length,
    ).toBeGreaterThan(0)
    expect(existsSync(retainedFile)).toBe(true)
    if (!deleteVolumes) {
      let protectedVolumes: string[] = []
      f.fake.provider.sweepOrphans = async (input) => {
        protectedVolumes = input.protectedVolumes
      }
      await f.vm.sweepOrphans()
      expect(protectedVolumes).toContain(volumes[0] ?? "")
    }
  })

test("provider failure keeps the bot and its conversations available for retry", async () => {
  const f = await fixture()
  const bot = await f.create("Falha")
  await (await f.vm.service.acquire({ botId: bot.id }))()
  f.fake.provider.destroy = async () => ({ success: false, errorCode: "COMMAND_FAILED", error: "fake failure" })

  const response = await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
  const body = await response.json()

  expect(response.status).toBe(409)
  expect(body).toMatchObject({ code: "TOURI-E8003", origin: "bot-deletion" })
  expect(JSON.stringify(body)).not.toContain("fake failure")
  expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: bot.id })?.paused).toBe(false)
  expect(f.db.query("SELECT id FROM threads WHERE bot_id = ?").all(bot.id)).toHaveLength(1)
})

test("local deletion never calls the machine provider", async () => {
  const f = await fixture()
  const bot = await f.create("Local", "local")
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(f.fake.calls).toHaveLength(0)
})

test("a volume mounted by another bot is never removed", async () => {
  const f = await fixture()
  const bot = await f.create("Compartilhado")
  const other = await f.create("Outro")
  await (await f.vm.service.acquire({ botId: bot.id }))()
  await (await f.vm.service.acquire({ botId: other.id }))()
  const meta = f.db.query("SELECT volume FROM bot_machines WHERE bot_id = ?").get(bot.id) as { volume: string }
  f.db.query("UPDATE bot_machines SET volume = ? WHERE bot_id = ?").run(meta.volume, other.id)
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name, deleteVolumes: true }, "DELETE")).status).toBe(200)
  expect(f.fake.calls.filter((call) => call.action === "deleteVolume")).toHaveLength(0)
})

test.each(["machine", "history"] as const)(
  "a failed %s deletion preserves the saved browser session and encryption key",
  async (deletionStep) => {
    const workspace = await fixture()
    const bot = await workspace.create("Session retry", deletionStep === "machine" ? "vm" : "local")
    const session = { cookies: [{ name: "sid", value: "fake", domain: "example.com", path: "/" }], storage: {} }
    expect(await saveBotSession({ kernel: workspace.runtime.kernel, botId: bot.id, session })).toBe(true)
    const sessionFile = botSessionPath(workspace.runtime.kernel, bot.id)
    const encryptedSession = readFileSync(sessionFile, "utf8")
    const releaseLease =
      deletionStep === "machine" ? await workspace.vm.service.acquire({ botId: bot.id }) : async () => {}
    if (deletionStep === "history")
      workspace.db
        .query("CREATE TRIGGER block_bot_deletion BEFORE DELETE ON bots BEGIN SELECT RAISE(ABORT, 'blocked'); END")
        .run()

    const response = await workspace.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")
    await releaseLease()

    expect(response.status).toBe(409)
    expect(workspace.db.query("SELECT id FROM bots WHERE id = ?").get(bot.id)).toEqual({ id: bot.id })
    expect(readFileSync(sessionFile, "utf8")).toBe(encryptedSession)
    expect(await loadBotSession(workspace.runtime.kernel, bot.id)).toEqual(session)
  },
)

test("R13-B03 deleting a bot removes its private browser session file", async () => {
  const f = await fixture()
  const bot = await f.create("Sessions", "local")
  await saveBotSession({
    kernel: f.runtime.kernel,
    botId: bot.id,
    session: { cookies: [{ name: "sid", value: "x", domain: "example.com", path: "/" }], storage: {} },
  })
  const file = botSessionPath(f.runtime.kernel, bot.id)
  expect(existsSync(file)).toBe(true)
  expect(JSON.parse(readFileSync(file, "utf8")).enc).toBe("aes-256-gcm")
  expect((await f.request(`/bots/${bot.id}`, { name: bot.name }, "DELETE")).status).toBe(200)
  expect(existsSync(file)).toBe(false)
})
