import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, Run } from "@touri/contracts"
import { botSessionPath, saveBotSession } from "../../src/browser/sessionVault"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { createEventBus } from "../../src/kernel/event-bus"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"
import { deleteBotRoute } from "../../src/vm/delete-bot"
import { createVmRuntime } from "../../src/vm/runtime"
import { fakeVmProvider } from "./fake-provider"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const fixture = async ({ callHost }: { callHost?: Kernel["callHost"] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-delete-bot-"))
  mkdirSync(join(root, ".codex"))
  writeFileSync(join(root, ".codex/auth.json"), JSON.stringify({ access_token: "fake-test-only" }))
  const runtime = createKernel({ appData: join(root, "data") })
  await initStore(runtime.kernel)
  const vault = new Map<string, string>()
  runtime.kernel.callHost =
    callHost ??
    ((async (method, params) => {
      const { account, value } = params as { account: string; value?: string }
      if (method === "keychain.get") return { success: true, value: { value: vault.get(account) ?? null } }
      if (method === "keychain.set" && value) vault.set(account, value)
      if (method === "keychain.delete") vault.delete(account)
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
  runtime.kernel.registerRoutes({ name: "delete-test", routes: [deleteBotRoute(runtime.kernel, vm.service)] })
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
  return { root, runtime, db: runtime.kernel.db as Database, fake, vm, request, create }
}

const makeGroupHistory = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const owner = await f.create("Group owner", "local")
  const participant = await f.create("Group participant", "local")
  const groups = createGroupStore(f.runtime.kernel)
  const group = groups.save({
    name: "Test group",
    color: "#dc2626",
    avatarShape: "cercle",
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
      "INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution) VALUES ('group-turn','group-call',?,'{}','succeeded')",
    )
    .run(thread.id)
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
