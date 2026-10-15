import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Bot, GroupInput, Run, ToolContext } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupRuntime } from "../../src/groups/runtime"
import { delegatedBot, delegationCeiling, delegationSecrets, setDelegation } from "../../src/groups/security"
import { createGroupStore, routeGroupMessage } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { createToolRouter } from "../../src/mcp/router"
import { createHistoryReadHandler } from "../../src/mcp/tools/history-read"
import { createHistorySearchHandler } from "../../src/mcp/tools/history-search"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { composeDeveloperInstructions } from "../../src/runtime/instructions"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const until = async (check: () => boolean) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out")
}
const fixture = async (
  hook?: (ctx: ToolContext, complete: (text: string) => void) => Promise<void>,
  timeout = 1000,
) => {
  const root = mkdtempSync(join(import.meta.dir, ".groups-"))
  const host = createKernel({ appData: root })
  await initStore(host.kernel)
  await initGroups(host.kernel)
  const db = host.kernel.db as Database
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const bots: Bot[] = []
  const headers = {
    Authorization: "Bearer dev-ui-token",
    Origin: "tauri://localhost",
    "Content-Type": "application/json",
  }
  const request = async (path: string, body?: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${host.handshake.port}/api/v1${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  for (const name of ["pm", "dev", "qa", "outsider"]) {
    const r = await request("/bots", { name, provider: "codex", instructions: "Own instructions" })
    bots.push(((await r.json()) as { bot: Bot }).bot)
  }
  const data = createGroupStore(host.kernel)
  const input: GroupInput = {
    name: "Produto",
    color: "#dc2626",
    avatarShape: "cercle",
    memberIds: bots.slice(0, 3).map((b) => b.id),
    coordinatorBotId: null,
  }
  const group = data.save(input)
  const thread = data.createThread(group)
  const persistence = createRuntimePersistence({ database: db })
  const running = new Map<string, { run: Run; ctx: ToolContext }>()
  const order: string[] = []
  const engine = {
    enqueue: ({ threadId, requestMessageId }: { threadId: string; requestMessageId: string }) => {
      const botId = store.getThread({ threadId })?.botId ?? ""
      const run: Run = {
        id: host.kernel.newId(),
        threadId,
        botId,
        provider: "codex",
        trigger: "user",
        requestMessageId,
        replyMessageId: null,
        externalTurnId: null,
        status: "running",
        errorClass: null,
        errorMessage: null,
        usage: null,
        routineRunId: null,
        queuedAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
      }
      persistence.saveRun(run)
      const ctx: ToolContext = {
        botId,
        threadId,
        runId: run.id,
        projectId: null,
        cwd: root,
        signal: new AbortController().signal,
      }
      running.set(run.id, { run, ctx })
      order.push(botId)
      queueMicrotask(async () => {
        const complete = (text: string) => {
          if (persistence.getRun(run.id)?.status !== "running") return
          const message = store.insertMessage({
            message: {
              id: host.kernel.newId(),
              threadId,
              parentId: requestMessageId,
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
          if (message.success) {
            run.replyMessageId = message.message.id
            host.kernel.publish({ type: "message.created", message: message.message })
          }
          Object.assign(run, { status: "succeeded", finishedAt: Date.now() })
          persistence.saveRun(run)
          host.kernel.publish({ type: "run.updated", run: { ...run } })
        }
        if (hook) await hook(ctx, complete)
        else complete(`${store.getBot({ botId })?.name} respondeu`)
      })
      return { success: true as const, run }
    },
    cancel: (id: string) => {
      const run = persistence.getRun(id)
      if (!run) return { success: false as const, errorCode: "NOT_FOUND" as const, error: "missing" }
      if (["running", "queued"].includes(run.status)) {
        Object.assign(run, { status: "canceled", finishedAt: Date.now() })
        persistence.saveRun(run)
        host.kernel.publish({ type: "run.updated", run })
      }
      return { success: true as const, run }
    },
  }
  host.kernel.services.provide(
    "runtime.activeRun",
    ({ threadId }) =>
      [...running.values()].find(
        (v) => v.run.threadId === threadId && persistence.getRun(v.run.id)?.status === "running",
      )?.run ?? null,
  )
  const runtime = createGroupRuntime(host.kernel, engine, timeout)
  host.kernel.services.provide("groups.runtime", runtime)
  host.kernel.services.provide("runtime.enqueue", runtime.enqueue)
  const send = (text: string, targetThreadId = thread.id) => {
    const m = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: targetThreadId,
        parentId: store.getThread({ threadId: targetThreadId })?.activeLeafId ?? null,
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
    if (!m.success) throw new Error(m.error)
    const r = runtime.enqueue({ threadId: targetThreadId, requestMessageId: m.message.id, trigger: "user" })
    if (!r.success) throw new Error(r.error)
    return r.run
  }
  cleanups.push(() => {
    runtime.shutdown()
    host.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    host,
    db,
    store,
    bots,
    group,
    thread,
    input,
    data,
    persistence,
    runtime,
    send,
    order,
    running,
    engine,
    request,
  }
}

test("routing uses coordinator, mentions (including quoted multiword names), then ordered roster", () => {
  const group = {
    id: "g",
    name: "g",
    color: "#dc2626",
    avatarShape: "cercle" as const,
    avatarSeed: "g",
    memberIds: ["a", "b"],
    coordinatorBotId: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const bots = [
    { id: "a", name: "PM" },
    { id: "b", name: "Dev Bot" },
  ]
  expect(routeGroupMessage(group, bots, '@"Dev Bot" consulte @pm')).toEqual(["a", "b"])
  expect(routeGroupMessage(group, bots, "@PMx olá")).toEqual(["a", "b"])
  expect(routeGroupMessage(group, bots, '@"Dev Bot", revise')).toEqual(["b"])
  expect(routeGroupMessage({ ...group, coordinatorBotId: "a" }, bots, '@"Dev Bot"')).toEqual(["a"])
})

test("groups have separate conversations, private member sessions, ordered replies and durable attribution", async () => {
  const f = await fixture()
  const run = f.send("Bom dia")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(f.order).toEqual(f.group.memberIds)
  const replies = f.store.activePath({ threadId: f.thread.id }).filter((m) => m.role === "assistant")
  expect(replies.map((m) => m.sender?.name)).toEqual(["pm", "dev", "qa"])
  expect(new Set(f.runtime.listRuns(f.thread.id).map((r) => r.botId)).size).toBe(3)
  const children = f.db.query("SELECT * FROM threads WHERE group_thread_id=?").all(f.thread.id) as {
    id: string
    bot_id: string
  }[]
  expect(children).toHaveLength(3)
  for (const t of children)
    expect(f.store.activePath({ threadId: t.id }).filter((m) => m.role === "assistant")).toHaveLength(1)
  const other = f.data.createThread(f.group, "Segunda")
  expect(f.store.activePath({ threadId: other.id })).toHaveLength(0)
  const direct = await f.request(`/bots/${f.bots[0]?.id}/threads`, undefined, "GET")
  expect(((await direct.json()) as { threads: { groupId?: string }[] }).threads.every((t) => !t.groupId)).toBe(true)
})

test("R11: a read-only coordinator's ask_bot gets a consent card and the target runs under a read-only ceiling", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  let targetAccess: string | undefined
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) {
      const router = createToolRouter({
        kernel: f.host.kernel,
        registrations: new Map([
          ["ask_bot", { name: "ask_bot", group: "core", handler: ({ ctx, args }) => f.runtime.askBot(ctx, args) }],
        ]),
      })
      answer = await router.call({
        id: 1,
        name: "ask_bot",
        args: { bot: "dev", message: "leia" },
        caller: {
          botId: ctx.botId,
          threadId: ctx.threadId,
          projectId: null,
          cwd: f.root,
          provider: "codex" as const,
          browserEnabled: false,
          computerUse: false,
        },
        signal: ctx.signal,
      })
      complete("Plano concluído")
      return
    }
    const target = f.store.getBot({ botId: ctx.botId })
    targetAccess = target ? delegatedBot(f.host.kernel, ctx.threadId, target).access : undefined
    complete("Lido")
  })
  f.db.query("UPDATE bots SET access = 'read-only', approvals = 'never' WHERE id = ?").run(f.bots[0]?.id ?? "")
  f.db.query("UPDATE bots SET access = 'full', approvals = 'never' WHERE id = ?").run(f.bots[1]?.id ?? "")
  const cards: string[] = []
  f.host.kernel.services.provide("approvals.present", async (input) => {
    cards.push(input.scope.tool ?? "")
    return { success: true, behavior: "allow" }
  })
  f.group = f.data.save({ ...f.input, coordinatorBotId: f.bots[0]?.id ?? null }, f.group)
  const run = f.send("@qa planeje")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(cards).toContain("ask_bot")
  expect(answer).toMatchObject({ success: true, structured: { answer: "Lido" } })
  expect(targetAccess).toBe("read-only")
})

test("queue serializes turns across group conversations; Parar cancels active and queued turns", async () => {
  const f = await fixture(async () => {})
  const first = f.send("primeiro")
  const other = f.data.createThread(f.group, "Outra conversa")
  const second = f.send("segundo", other.id)
  await until(() => f.order.length === 1)
  expect((await f.request(`/groups/${f.group.id}`, f.input, "PATCH")).status).toBe(409)
  expect(f.runtime.cancel(first.id)).toBe(true)
  await until(() => f.persistence.getRun(first.id)?.status === "canceled")
  expect(f.persistence.getRun(second.id)?.status).toBe("canceled")
  expect(f.order).toHaveLength(1)
})

test("coordinator receives requests; real MCP router returns peer answer and group capabilities", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) {
      const router = createToolRouter({
        kernel: f.host.kernel,
        registrations: new Map([
          ["ask_bot", { name: "ask_bot", group: "core", handler: ({ ctx, args }) => f.runtime.askBot(ctx, args) }],
        ]),
      })
      const caller = {
        botId: ctx.botId,
        threadId: ctx.threadId,
        projectId: null,
        cwd: f.root,
        provider: "codex" as const,
        browserEnabled: false,
        computerUse: false,
      }
      expect(router.list({ caller }).map((t) => t.name)).toContain("ask_bot")
      const instructions = await composeDeveloperInstructions({
        kernel: f.host.kernel,
        bot: f.bots[0] as Bot,
        thread: f.store.getThread({ threadId: ctx.threadId }) as NonNullable<ReturnType<typeof f.store.getThread>>,
        cwd: f.root,
      })
      expect(instructions).toContain("with the coordinator role")
      answer = await router.call({
        id: 1,
        name: "ask_bot",
        args: { bot: "dev", message: "implemente" },
        caller,
        signal: ctx.signal,
      })
      complete("Plano concluído")
    } else complete("Código pronto")
  })
  f.host.kernel.services.provide("approvals.present", async () => ({ success: true, behavior: "allow" }))
  f.group = f.data.save({ ...f.input, coordinatorBotId: f.bots[0]?.id ?? null }, f.group)
  const run = f.send("@qa planeje")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(answer).toMatchObject({ success: true, structured: { answer: "Código pronto" } })
  expect(f.order).toEqual(f.bots.slice(0, 2).map((b) => b.id))
  const outside = await f.runtime.askBot(
    {
      botId: f.bots[0]?.id ?? "",
      threadId: f.thread.id,
      runId: run.id,
      cwd: f.root,
      projectId: null,
      signal: new AbortController().signal,
    },
    { bot: "dev", message: "task" },
  )
  expect(outside).toMatchObject({ success: false, errorCode: "NOT_IN_GROUP" })
})

test("ask_bot enforces membership, cycle, depth 2 and six calls across the whole turn", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let calls = 0
  f = await fixture(async (ctx, complete) => {
    const ask = (bot: string) => f.runtime.askBot(ctx, { bot, message: "task" })
    if (ctx.botId === f.bots[0]?.id) {
      expect(await ask("outsider")).toMatchObject({ errorCode: "NOT_IN_GROUP" })
      expect(await ask("pm")).toMatchObject({ errorCode: "DELEGATION_LOOP" })
      expect(await ask("dev")).toMatchObject({ success: true })
      calls += 1
      for (let i = 0; i < 4; i++) expect(await ask("qa")).toMatchObject({ success: true })
      expect(await ask("qa")).toMatchObject({ errorCode: "DELEGATION_LIMIT" })
    } else if (ctx.botId === f.bots[1]?.id) {
      expect(await ask("pm")).toMatchObject({ errorCode: "DELEGATION_LOOP" })
      expect(await ask("qa")).toMatchObject({ success: true })
      calls += 1
    } else {
      const link = f.db.query("SELECT depth FROM group_run_links WHERE run_id=?").get(ctx.runId) as { depth: number }
      if (link.depth === 2) expect(await ask("dev")).toMatchObject({ errorCode: "DELEGATION_DEPTH" })
    }
    complete("feito")
  })
  f.group = f.data.save({ ...f.input, coordinatorBotId: f.bots[0]?.id ?? null }, f.group)
  const run = f.send("delegue")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(calls).toBe(2)
  expect(f.db.query("SELECT COUNT(*) AS n FROM group_run_links WHERE depth>0").get()).toEqual({ n: 6 })
})

test("target approval stays pending until user decision; timeout cancels a stalled bot", async () => {
  let finish: ((text: string) => void) | undefined
  const f = await fixture(async (ctx, complete) => {
    finish = complete
    const message = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: ctx.threadId,
        parentId: f.store.getThread({ threadId: ctx.threadId })?.activeLeafId ?? null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: ctx.runId,
        text: "",
        parts: [
          {
            type: "approval",
            approvalId: "peer-approval",
            request: "permission",
            detail: "Bash",
            decision: "pending",
          },
        ],
        sender: null,
        source: "local",
      },
    })
    if (message.success) f.host.kernel.publish({ type: "message.created", message: message.message })
  }, 100)
  const run = f.send("@dev execute")
  await until(() => !!finish)
  expect(f.persistence.getRun(run.id)?.status).toBe("running")
  expect(
    f.store
      .activePath({ threadId: f.thread.id })
      .some((m) => m.parts.some((p) => p.type === "approval" && p.decision === "pending")),
  ).toBe(true)
  await until(() => f.persistence.getRun(run.id)?.status === "failed")
  finish?.("late answer")
  expect(f.store.activePath({ threadId: f.thread.id }).some((m) => m.text === "late answer")).toBe(false)
})

test("0008 upgrades a populated version 7 DB atomically and can reopen safely", async () => {
  const f = await fixture()
  const name = f.bots[0]?.name
  // Drop only the new additive structures to reproduce the pre-0008 shape.
  const filename = join(f.root, "legacy.db")
  const legacy = new Database(filename)
  for (let n = 1; n <= 7; n++)
    legacy.exec(
      await Bun.file(join(import.meta.dir, `../../src/kernel/migrations/${String(n).padStart(4, "0")}.sql`)).text(),
    )
  legacy
    .query(
      "INSERT INTO bots(id,name,instructions,instructions_hash,provider,access,approvals,home_dir,created_at,updated_at) VALUES('existing',?,'soul','hash','codex','workspace-write','on-request','/private',1,1)",
    )
    .run(name ?? "pm")
  legacy.close()
  const db = openDatabase({ filename })
  expect(db.query("SELECT name FROM bots WHERE id='existing'").get()).toEqual({ name })
  expect(db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({
    value: String(SCHEMA_VERSION),
  })
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  db.close()
  const reopened = openDatabase({ filename })
  expect(reopened.query("SELECT COUNT(*) AS n FROM bots").get()).toEqual({ n: 1 })
  reopened.close()
})

test("real provider runtime delegates with concurrency cap 1, isolated sessions and target approvals", async () => {
  const f = await fixture()
  f.runtime.shutdown()
  const scenario = join(f.root, "scenario.json")
  const command = join(f.root, "fake-codex")
  const fake = join(import.meta.dir, "../fakes/fake-codex.ts")
  writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 })
  writeFileSync(
    scenario,
    JSON.stringify({
      waitForApproval: true,
      events: [
        { type: "delta", delta: "Plano" },
        { type: "approval", approvalId: "pm-permission", command: "echo pm" },
      ],
    }),
  )
  const engine = createRuntimeEngine({
    kernel: f.host.kernel,
    codexCommand: command,
    environment: { PATH: process.env.PATH ?? "", TOURI_FAKE_SCENARIO: scenario },
    maxConcurrentRuns: 1,
    interruptGraceMs: 100,
  })
  f.host.kernel.services.provide("approvals.present", engine.approvalBridge.present)
  const groups = createGroupRuntime(f.host.kernel, engine, 3000)
  cleanups.unshift(() => groups.shutdown())
  f.host.kernel.services.provide("groups.runtime", groups)
  f.host.kernel.services.provide("runtime.activeRun", engine.activeRun)
  const group = f.data.save({ ...f.input, coordinatorBotId: f.bots[0]?.id ?? null }, f.group)
  const message = f.store.insertMessage({
    message: {
      id: f.host.kernel.newId(),
      threadId: f.thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "delegue",
      parts: [{ type: "text", text: "delegue" }],
      sender: null,
      source: "local",
    },
  })
  if (!message.success) throw new Error(message.error)
  const queued = groups.enqueue({ threadId: f.thread.id, requestMessageId: message.message.id, trigger: "user" })
  if (!queued.success) throw new Error(queued.error)
  const pm = f.data.participant(group, f.thread.id, f.bots[0]?.id ?? "")
  await until(() => f.store.activePath({ threadId: pm.id }).some((m) => m.parts.some((p) => p.type === "approval")))
  writeFileSync(
    scenario,
    JSON.stringify({
      waitForApproval: true,
      events: [
        { type: "delta", delta: "Código entregue" },
        { type: "approval", approvalId: "dev-permission", command: "echo dev" },
      ],
    }),
  )
  const router = createToolRouter({
    kernel: f.host.kernel,
    registrations: new Map([
      ["ask_bot", { name: "ask_bot", group: "core", handler: ({ ctx, args }) => groups.askBot(ctx, args) }],
    ]),
  })
  const caller = {
    botId: pm.botId,
    threadId: pm.id,
    projectId: null,
    cwd: f.root,
    provider: "codex" as const,
    browserEnabled: false,
    computerUse: false,
  }
  const approval = (threadId: string, tool?: string) =>
    f.store
      .activePath({ threadId })
      .flatMap((message) => message.parts)
      .find((part) => part.type === "approval" && part.decision === "pending" && (!tool || part.scope?.tool === tool))
  let resolved = false
  const answer = router
    .call({
      id: 1,
      name: "ask_bot",
      args: { bot: "dev", message: "implemente" },
      caller,
      signal: new AbortController().signal,
    })
    .then((value) => {
      resolved = true
      return value
    })
  await until(() => !!approval(pm.id, "ask_bot"))
  const delegateApproval = approval(pm.id, "ask_bot")
  if (delegateApproval?.type !== "approval") throw new Error("Missing delegation approval")
  expect((await engine.answerApproval({ approvalId: delegateApproval.approvalId, decision: "approved" })).success).toBe(
    true,
  )
  const dev = f.data.participant(group, f.thread.id, f.bots[1]?.id ?? "")
  await until(() => f.store.activePath({ threadId: dev.id }).some((m) => m.parts.some((p) => p.type === "approval")))
  expect(resolved).toBe(false)
  expect(
    f.store
      .activePath({ threadId: f.thread.id })
      .some((m) => m.sender?.name === "dev" && m.parts.some((p) => p.type === "approval" && p.decision === "pending")),
  ).toBe(true)
  const devApproval = approval(dev.id)
  if (devApproval?.type !== "approval") throw new Error("Missing target approval")
  expect(await engine.answerApproval({ approvalId: devApproval.approvalId, decision: "approved" })).toMatchObject({
    success: true,
  })
  expect(await answer).toMatchObject({ success: true, structured: { answer: "Código entregue" } })
  const pmApproval = approval(pm.id)
  if (pmApproval?.type !== "approval") throw new Error("Missing coordinator approval")
  expect(await engine.answerApproval({ approvalId: pmApproval.approvalId, decision: "approved" })).toMatchObject({
    success: true,
  })
  await until(() => f.persistence.getRun(queued.run.id)?.status === "succeeded")
  expect(f.db.query("SELECT COUNT(*) AS n FROM provider_sessions WHERE thread_id IN (?,?)").get(pm.id, dev.id)).toEqual(
    { n: 2 },
  )
  const nextMessage = f.store.insertMessage({
    message: {
      ...message.message,
      id: f.host.kernel.newId(),
      parentId: f.store.getThread({ threadId: f.thread.id })?.activeLeafId ?? null,
    },
  })
  if (!nextMessage.success) throw new Error(nextMessage.error)
  const next = groups.enqueue({ threadId: f.thread.id, requestMessageId: nextMessage.message.id, trigger: "user" })
  if (!next.success) throw new Error(next.error)
  const pending = (id: string) =>
    f.store
      .activePath({ threadId: id })
      .some((m) => m.parts.some((p) => p.type === "approval" && p.decision === "pending"))
  await until(() => pending(pm.id))
  const canceledAnswer = router.call({
    id: 2,
    name: "ask_bot",
    args: { bot: "dev", message: "novo pedido" },
    caller,
    signal: new AbortController().signal,
  })
  await until(() => !!approval(pm.id, "ask_bot"))
  const secondDelegation = approval(pm.id, "ask_bot")
  if (secondDelegation?.type !== "approval") throw new Error("Missing delegation approval")
  await engine.answerApproval({ approvalId: secondDelegation.approvalId, decision: "approved" })
  await until(() => pending(dev.id))
  expect(groups.cancel(next.run.id)).toBe(true)
  expect(await canceledAnswer).toMatchObject({ success: false, errorCode: "CANCELED" })
  await until(() => f.persistence.getRun(next.run.id)?.status === "canceled")
  expect(pending(f.thread.id)).toBe(false)
  await engine.shutdown()
}, 15000)

test("HTTP group CRUD validates roster/coordinator and reassigns shared ownership without changing member history", async () => {
  const f = await fixture()
  const list = await f.request("/groups", undefined, "GET")
  expect(list.status).toBe(200)
  expect(((await list.json()) as { groups: { id: string }[] }).groups.map((g) => g.id)).toContain(f.group.id)
  for (const invalid of [
    { ...f.input, memberIds: [] },
    { ...f.input, memberIds: [f.input.memberIds[0], f.input.memberIds[0]] },
    { ...f.input, coordinatorBotId: f.bots[3]?.id },
    { ...f.input, color: "javascript:invalid" },
  ])
    expect((await f.request("/groups", invalid)).status).toBe(400)
  const child = f.data.participant(f.group, f.thread.id, f.bots[0]?.id ?? "")
  const edit = await f.request(`/groups/${f.group.id}`, { ...f.input, memberIds: f.input.memberIds.slice(1) }, "PATCH")
  expect(edit.status).toBe(200)
  expect(f.store.getThread({ threadId: f.thread.id })?.botId).toBe(f.bots[1]?.id)
  expect(f.store.getThread({ threadId: child.id })?.botId).toBe(f.bots[0]?.id)
  const created = await f.request(`/groups/${f.group.id}/threads`, { title: "Nova conversa" })
  expect(created.status).toBe(201)
  expect(((await created.json()) as { thread: { groupId: string } }).thread.groupId).toBe(f.group.id)
})

test("restart interrupts shared streaming replies, expires approvals and never redelivers a group task", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async (ctx) => {
    const message = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: ctx.threadId,
        parentId: f.store.getThread({ threadId: ctx.threadId })?.activeLeafId ?? null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: ctx.runId,
        text: "Parcial",
        parts: [
          { type: "text", text: "Parcial" },
          {
            type: "approval",
            approvalId: "restart-permission",
            request: "permission",
            detail: "Bash",
            decision: "pending",
          },
        ],
        sender: null,
        source: "local",
      },
    })
    if (message.success) f.host.kernel.publish({ type: "message.created", message: message.message })
  })
  const root = f.send("@dev execute")
  await until(() => f.store.activePath({ threadId: f.thread.id }).some((m) => m.status === "streaming"))
  f.runtime.shutdown()
  await until(() => f.persistence.getRun(root.id)?.status === "canceled")
  f.db.query("UPDATE runs SET status='running',finished_at=NULL WHERE id=?").run(root.id)
  const recovered = createGroupRuntime(f.host.kernel, f.engine)
  cleanups.unshift(() => recovered.shutdown())
  expect(f.persistence.getRun(root.id)?.status).toBe("interrupted")
  const reply = f.store.activePath({ threadId: f.thread.id }).find((m) => m.role === "assistant")
  expect(reply?.status).toBe("failed")
  expect(reply?.parts.some((p) => p.type === "approval" && p.decision === "expired")).toBe(true)
  expect(f.order).toHaveLength(1)
})

test("B05: boundary-crossing ask_bot waits for exact human consent and denial prevents target execution", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  let decide: ((allow: boolean) => void) | undefined
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) answer = await f.runtime.askBot(ctx, { bot: "dev", message: "run on host" })
    complete("done")
  })
  f.db.query("UPDATE bots SET machine='vm',access='read-only' WHERE id=?").run(f.bots[0]?.id ?? "")
  f.db.query("UPDATE bots SET machine='local',access='full' WHERE id=?").run(f.bots[1]?.id ?? "")
  f.host.kernel.services.provide("approvals.present", async (input) => {
    expect(input.allowStanding).toBe(false)
    expect(input.input).toMatchObject({ message: "run on host" })
    return new Promise((resolve) => {
      decide = (allow) => resolve({ success: true, behavior: allow ? "allow" : "deny" })
    })
  })
  const run = f.send("@pm delegate")
  await until(() => !!decide || f.order.length > 1)
  expect(f.order).toEqual([f.bots[0]?.id ?? ""])
  expect(decide).toBeDefined()
  decide?.(false)
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(answer).toMatchObject({ success: false, errorCode: "DELEGATION_DENIED" })
})

test("B05: delegated requests preserve bot provenance rather than claiming a human instruction", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let request: ReturnType<typeof f.store.activePath>[number] | undefined
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) await f.runtime.askBot(ctx, { bot: "dev", message: "peer task" })
    else request = f.store.activePath({ threadId: ctx.threadId }).find((m) => m.role === "user")
    complete("done")
  })
  const run = f.send("@pm delegate")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(request?.sender).toEqual({ id: f.bots[0]?.id ?? "", name: "pm" })
  expect(request?.text).toContain("Mensagem delegada do bot")
  expect(request?.text).toContain('"name":"pm"')
})

test("A16: group participant history tools and memory cannot disclose private bot conversations", async () => {
  const f = await fixture()
  const bot = f.bots[1] as Bot
  const privateThread = f.store.getThread({ threadId: bot.mainThreadId ?? "" })
  if (!privateThread) throw new Error("missing private thread")
  f.store.insertMessage({
    message: {
      id: f.host.kernel.newId(),
      threadId: privateThread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "private-history-canary",
      parts: [{ type: "text", text: "private-history-canary" }],
      sender: null,
      source: "local",
    },
  })
  writeFileSync(join(bot.homeDir, "MEMORY.md"), "private-memory-canary")
  const participant = f.data.participant(f.group, f.thread.id, bot.id)
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: participant.id,
    runId: null,
    projectId: null,
    cwd: f.root,
    signal: new AbortController().signal,
  }
  const search = await createHistorySearchHandler({ kernel: f.host.kernel })({
    ctx,
    args: { query: "private-history-canary" },
  })
  expect(JSON.stringify(search)).not.toContain("private-history-canary")
  const read = await createHistoryReadHandler({ kernel: f.host.kernel })({ ctx, args: { threadId: privateThread.id } })
  expect(read).toMatchObject({ success: false })
  const prompt = await composeDeveloperInstructions({ kernel: f.host.kernel, bot, thread: participant, cwd: f.root })
  expect(prompt).not.toContain("private-memory-canary")
})

test("B05: approved delegation runs under the caller ceiling instead of failing closed", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  let approvals = 0
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) answer = await f.runtime.askBot(ctx, { bot: "dev", message: "task" })
    complete("done")
  })
  f.db.query("UPDATE bots SET access='read-only' WHERE id=?").run(f.bots[0]?.id ?? "")
  f.db.query("UPDATE bots SET access='full' WHERE id=?").run(f.bots[1]?.id ?? "")
  f.host.kernel.services.provide("approvals.present", async () => {
    approvals++
    return { success: true, behavior: "allow" }
  })
  const run = f.send("@pm delegate")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(approvals).toBe(1)
  expect(answer).toMatchObject({ success: true })
  expect(f.order).toEqual(f.bots.slice(0, 2).map((b) => b.id))
})

test("B05: ceiling never lets a guest caller reach host execution without approval and keeps peers equal otherwise", () => {
  const base = { access: "full", approvals: "never", machine: "local" } as Bot
  const guest = delegationCeiling({ ...base, machine: "vm" }, base)
  expect(guest).toMatchObject({ access: "workspace-write", approvals: "on-request", machine: "local" })
  expect(delegationCeiling({ ...base, machine: "vm", access: "read-only" }, base).access).toBe("read-only")
  expect(delegationCeiling({ ...base, machine: "vm" }, { ...base, machine: "vm" })).toMatchObject({
    access: "full",
    approvals: "never",
  })
  expect(delegationCeiling(base, base)).toMatchObject({ access: "full", approvals: "never" })
  expect(
    delegationSecrets({ caller: { ...base, projectId: "p" } as Bot, target: { ...base, projectId: "p" } as Bot }),
  ).toBe(true)
  expect(
    delegationSecrets({ caller: { ...base, projectId: "p" } as Bot, target: { ...base, projectId: "q" } as Bot }),
  ).toBe(false)
  expect(delegationSecrets({ caller: base, target: base })).toBe(false)
})

test("B05: the real engine starts a delegated provider turn under the ceiling, and unchanged for equal peers", async () => {
  const f = await fixture()
  f.runtime.shutdown()
  const scenario = join(f.root, "scenario.json")
  const argvLog = join(f.root, "argv.log")
  const command = join(f.root, "fake-codex")
  const fake = join(import.meta.dir, "../fakes/fake-codex.ts")
  writeFileSync(command, `#!/bin/sh\necho "$@" >> '${argvLog}'\nexec '${process.execPath}' '${fake}' "$@"\n`, {
    mode: 0o700,
  })
  writeFileSync(scenario, JSON.stringify({ events: [{ type: "delta", delta: "ok" }, { type: "complete" }] }))
  const pm = f.bots[0] as Bot
  const dev = f.bots[1] as Bot
  f.db.query("UPDATE bots SET access='full', approvals='never', machine='local' WHERE id IN (?,?)").run(pm.id, dev.id)
  const runDelegated = async (caller: Bot): Promise<string> => {
    const target = f.store.getBot({ botId: dev.id }) as Bot
    const participant = f.data.participant(f.group, f.thread.id, dev.id)
    setDelegation(f.host.kernel, participant.id, {
      ceiling: delegationCeiling(caller, target),
      caller: { id: caller.id, name: caller.name },
      groupThreadId: f.thread.id,
      secrets: true,
    })
    const message = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: participant.id,
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "task",
        parts: [{ type: "text", text: "task" }],
        sender: { id: caller.id, name: caller.name },
        source: "local",
      },
    })
    if (!message.success) throw new Error(message.error)
    writeFileSync(argvLog, "")
    const engine = createRuntimeEngine({
      kernel: f.host.kernel,
      codexCommand: command,
      environment: { PATH: process.env.PATH ?? "", TOURI_FAKE_SCENARIO: scenario },
      interruptGraceMs: 100,
    })
    const queued = engine.enqueue({
      threadId: participant.id,
      requestMessageId: message.message.id,
      trigger: "user",
      delegated: true,
    })
    if (!queued.success) throw new Error(queued.error)
    const id = queued.run.id
    for (
      let i = 0;
      i < 600 && ["queued", "starting", "running"].includes(f.persistence.getRun(id)?.status ?? "queued");
      i++
    )
      await Bun.sleep(20)
    setDelegation(f.host.kernel, participant.id, null)
    await engine.shutdown()
    return readFileSync(argvLog, "utf8")
  }
  const equal = await runDelegated(f.store.getBot({ botId: pm.id }) as Bot)
  expect(equal).toContain("danger-full-access")
  const reduced = await runDelegated({ ...(f.store.getBot({ botId: pm.id }) as Bot), access: "read-only" })
  expect(reduced).not.toContain("danger-full-access")
  expect(reduced).toContain("read-only")
  const guest = await runDelegated({ ...(f.store.getBot({ botId: pm.id }) as Bot), machine: "vm" })
  expect(guest).not.toContain("danger-full-access")
}, 20000)

test("B05: approval cannot survive target configuration changes while waiting", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) answer = await f.runtime.askBot(ctx, { bot: "dev", message: "task" })
    complete("done")
  })
  f.db.query("UPDATE bots SET machine='vm' WHERE id=?").run(f.bots[1]?.id ?? "")
  f.host.kernel.services.provide("approvals.present", async () => {
    f.db.query("UPDATE bots SET access='full' WHERE id=?").run(f.bots[1]?.id ?? "")
    return { success: true, behavior: "allow" }
  })
  const run = f.send("@pm delegate")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(answer).toMatchObject({ success: false, errorCode: "DELEGATION_DENIED" })
  expect(f.order).toEqual([f.bots[0]?.id ?? ""])
})

test("B05: capability intersections never exceed either peer and safe cross-machine consent permits delegation", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  let approvals = 0
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) answer = await f.runtime.askBot(ctx, { bot: "dev", message: "safe peer task" })
    complete("done")
  })
  const bot = f.bots[0] as Bot
  const access = ["read-only", "workspace-write", "full"] as const
  for (const a of access)
    for (const b of access) {
      const ceiling = delegationCeiling(
        { ...bot, access: a, computerUse: false },
        { ...bot, access: b, computerUse: true },
      )
      expect(access.indexOf(ceiling.access)).toBe(Math.min(access.indexOf(a), access.indexOf(b)))
      expect(ceiling.computerUse).toBe(false)
    }
  f.db.query("UPDATE bots SET machine='vm' WHERE id=?").run(f.bots[1]?.id ?? "")
  f.host.kernel.services.provide("approvals.present", async (input) => {
    approvals++
    expect(input.allowStanding).toBe(false)
    return { success: true, behavior: "allow" }
  })
  const run = f.send("@pm delegate")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(approvals).toBe(1)
  expect(answer).toMatchObject({ success: true })
  expect(f.order).toEqual(f.bots.slice(0, 2).map((b) => b.id))
})

test("A16: group-scoped history is readable and private history requires fresh explicit consent", async () => {
  const f = await fixture()
  const bot = f.bots[1] as Bot
  const privateThread = f.store.getThread({ threadId: bot.mainThreadId ?? "" })
  if (!privateThread) throw new Error("missing private thread")
  const participant = f.data.participant(f.group, f.thread.id, bot.id)
  for (const [threadId, text] of [
    [f.thread.id, "shared-canary"],
    [privateThread.id, "private-canary"],
  ] as const)
    f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId,
        parentId: null,
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
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: participant.id,
    runId: null,
    projectId: null,
    cwd: f.root,
    signal: new AbortController().signal,
  }
  const search = createHistorySearchHandler({ kernel: f.host.kernel })
  const read = createHistoryReadHandler({ kernel: f.host.kernel })
  expect(JSON.stringify(await search({ ctx, args: { query: "shared-canary" } }))).toContain("shared-canary")
  expect(JSON.stringify(await read({ ctx, args: { threadId: f.thread.id } }))).toContain("shared-canary")
  let reviews = 0
  f.host.kernel.services.provide("approvals.present", async (input) => {
    expect(input.allowStanding).toBe(false)
    reviews++
    return { success: true, behavior: reviews === 1 ? "allow" : "deny" }
  })
  expect(JSON.stringify(await read({ ctx, args: { threadId: privateThread.id } }))).toContain("private-canary")
  expect(await read({ ctx, args: { threadId: privateThread.id } })).toMatchObject({ success: false })
  expect(reviews).toBe(2)
})

const LEAKED_TOKEN = "ghp_0123456789abcdefABCDEF"
const REGISTERED_SECRET = "registered-provider-secret-value"
const failWithProviderText = (f: Awaited<ReturnType<typeof fixture>>, runId: string | null) => {
  const run = runId ? f.persistence.getRun(runId) : null
  if (!run) throw new Error("Missing delegated run")
  const failed: Run = {
    ...run,
    status: "failed",
    errorClass: "cli_crash",
    errorMessage: `Codex exited (1): token=${LEAKED_TOKEN} ${REGISTERED_SECRET}`,
    finishedAt: Date.now(),
  }
  f.persistence.saveRun(failed)
  f.host.kernel.publish({ type: "run.updated", run: failed })
}

test("#4 a failed member run's provider error text is redacted before the group run persists it", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async (ctx) => failWithProviderText(f, ctx.runId))
  f.host.kernel.addRedactionValue(REGISTERED_SECRET)
  const run = f.send("@dev execute")
  await until(() => f.persistence.getRun(run.id)?.status === "failed")
  const persisted = JSON.stringify(f.persistence.getRun(run.id))
  expect(persisted).toContain("[REDACTED]")
  expect(persisted).not.toContain(LEAKED_TOKEN)
  expect(persisted).not.toContain(REGISTERED_SECRET)
})

test("#4 ask_bot returns a delegated failure to the caller only after redaction", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let answer: unknown
  f = await fixture(async (ctx, complete) => {
    if (ctx.botId !== f.bots[0]?.id) return failWithProviderText(f, ctx.runId)
    answer = await f.runtime.askBot(ctx, { bot: "dev", message: "task" })
    complete("feito")
  })
  f.host.kernel.addRedactionValue(REGISTERED_SECRET)
  f.group = f.data.save({ ...f.input, coordinatorBotId: f.bots[0]?.id ?? null }, f.group)
  const run = f.send("delegue")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
  expect(answer).toMatchObject({ success: false, errorCode: "DELEGATION_FAILED" })
  expect(JSON.stringify(answer)).toContain("[REDACTED]")
  expect(JSON.stringify(answer)).not.toContain(LEAKED_TOKEN)
  expect(JSON.stringify(answer)).not.toContain(REGISTERED_SECRET)
})

test("#4 group sessions cannot list or rewrite the bot's private routines", async () => {
  const f = await fixture()
  const bot = f.bots[1] as Bot
  const participant = f.data.participant(f.group, f.thread.id, bot.id)
  const calls: string[] = []
  const routineTool = (name: string) =>
    [
      name,
      {
        name,
        group: "core" as const,
        handler: async () => {
          calls.push(name)
          return { success: true as const, content: [{ type: "text" as const, text: "private-routine-canary" }] }
        },
      },
    ] as const
  const router = createToolRouter({
    kernel: f.host.kernel,
    registrations: new Map([routineTool("routine_list"), routineTool("routine_create"), routineTool("routine_update")]),
  })
  const caller = (threadId: string) => ({
    botId: bot.id,
    threadId,
    projectId: null,
    cwd: f.root,
    provider: "codex" as const,
    browserEnabled: false,
    computerUse: false,
  })
  const routineNames = ["routine_list", "routine_create", "routine_update"]
  const listed = (threadId: string) =>
    router
      .list({ caller: caller(threadId) })
      .map((tool) => tool.name)
      .filter((name) => routineNames.includes(name))
  expect(listed(bot.mainThreadId ?? "")).toEqual(routineNames)
  expect(listed(participant.id)).toEqual([])
  const fromGroup = await router.call({
    id: 1,
    name: "routine_list",
    args: {},
    caller: caller(participant.id),
    signal: new AbortController().signal,
  })
  expect(fromGroup).toMatchObject({ success: false, errorCode: "TOOL_NOT_FOUND" })
  expect(JSON.stringify(fromGroup)).not.toContain("private-routine-canary")
  const update = await router.call({
    id: 2,
    name: "routine_update",
    args: { routineId: "r1", prompt: "leak private history" },
    caller: caller(participant.id),
    signal: new AbortController().signal,
  })
  expect(update).toMatchObject({ success: false, errorCode: "TOOL_NOT_FOUND" })
  expect(calls).toEqual([])
  const direct = await router.call({
    id: 3,
    name: "routine_list",
    args: {},
    caller: caller(bot.mainThreadId ?? ""),
    signal: new AbortController().signal,
  })
  expect(JSON.stringify(direct)).toContain("private-routine-canary")
  f.host.kernel.services.provide("mcp.botTools", () => ["history_search", ...routineNames])
  const groupPrompt = await composeDeveloperInstructions({
    kernel: f.host.kernel,
    bot,
    thread: participant,
    cwd: f.root,
  })
  expect(groupPrompt).toContain("history_search")
  expect(groupPrompt).not.toContain("routine_")
  const privateThread = f.store.getThread({ threadId: bot.mainThreadId ?? "" })
  if (!privateThread) throw new Error("missing private thread")
  const directPrompt = await composeDeveloperInstructions({
    kernel: f.host.kernel,
    bot,
    thread: privateThread,
    cwd: f.root,
  })
  expect(directPrompt).toContain("routine_list")
})
