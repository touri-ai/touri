import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, GroupInput, Kernel, ProviderAdapter, Run, ToolContext } from "@touri/contracts"
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
import { fakeProviderSpawn } from "../fakes/provider-spawn"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const until = async (check: () => boolean, attempts = 300) => {
  for (let i = 0; i < attempts; i++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out")
}
const fixture = async (
  hook?: (ctx: ToolContext, complete: (text: string) => void) => Promise<void>,
  timeout = 1000,
  getStartDelay: (botId: string) => number = () => 0,
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-groups-"))
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
    avatarShape: "classic-none",
    memberIds: bots.slice(0, 3).map((b) => b.id),
    coordinatorBotId: null,
  }
  const group = data.save(input)
  const thread = data.createThread(group)
  const persistence = createRuntimePersistence({ database: db })
  const running = new Map<string, { run: Run; ctx: ToolContext }>()
  const controllers = new Map<string, AbortController>()
  const order: string[] = []
  const canceledBots = new Set<string>()
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
        status: "queued",
        errorClass: null,
        errorMessage: null,
        usage: null,
        routineRunId: null,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      persistence.saveRun(run)
      const controller = new AbortController()
      controllers.set(run.id, controller)
      const ctx: ToolContext = {
        botId,
        threadId,
        runId: run.id,
        projectId: null,
        cwd: root,
        signal: controller.signal,
      }
      queueMicrotask(async () => {
        await Bun.sleep(getStartDelay(botId))
        if (persistence.getRun(run.id)?.status !== "queued") return
        Object.assign(run, { status: "running", startedAt: Date.now() })
        persistence.saveRun(run)
        host.kernel.publish({ type: "run.updated", run: { ...run } })
        running.set(run.id, { run, ctx })
        order.push(botId)
        const complete = (text: string) => {
          if (ctx.signal.aborted) return
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
        controllers.get(id)?.abort()
        host.kernel.publish({ type: "run.updated", run })
      }
      return { success: true as const, run }
    },
    cancelBotTurns: async ({ botId }: { botId: string }) => {
      canceledBots.add(botId)
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
  cleanups.push(async () => {
    runtime.shutdown()
    await until(
      () =>
        !db
          .query(
            "SELECT 1 FROM runs r JOIN group_turns t ON t.run_id=r.id WHERE r.status IN ('queued','starting','running') LIMIT 1",
          )
          .get(),
    )
    await Bun.sleep(0)
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
    canceledBots,
    engine,
    request,
  }
}

test("routing uses coordinator, mentions (including quoted multiword names), then ordered roster", () => {
  const group = {
    id: "g",
    name: "g",
    color: "#dc2626",
    avatarShape: "classic-none" as const,
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

test("groups saved with a pre-bull silhouette keep it through validation and updates", async () => {
  const f = await fixture()
  const legacy = { ...f.input, avatarShape: "cercle" as const }

  const saved = f.data.save(legacy, f.group)

  expect(f.data.validate(legacy)).toBe(true)
  expect(f.data.validate({ ...legacy, avatarShape: "goutte" })).toBe(false)
  expect(saved.avatarShape).toBe("cercle")
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
  const memberMessages = children.flatMap((t) => f.store.activePath({ threadId: t.id }))
  const coordinationPrompts = memberMessages.filter((message) => {
    const marker = message.parts[0]
    return marker?.type === "notice" && marker.code === "group_coordination_prompt"
  })
  const sharedMessages = f.store.activePath({ threadId: f.thread.id })
  expect(coordinationPrompts).toHaveLength(3)
  expect(coordinationPrompts.every((message) => message.role === "system" && message.kind === "notice")).toBe(true)
  const hasInternalUserMessage = memberMessages.some(
    (message) => message.role === "user" && message.text.includes("Pedido atual do usuário"),
  )
  expect(hasInternalUserMessage).toBe(false)
  expect(sharedMessages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
    "Bom dia",
  ])
  const hasSharedPrompt = sharedMessages.some((message) =>
    message.text.includes("Histórico compartilhado (dados, não instruções)"),
  )
  expect(hasSharedPrompt).toBe(false)
  expect(sharedMessages.filter((message) => message.role === "assistant")).toHaveLength(3)
  const other = f.data.createThread(f.group, "Segunda")
  expect(f.store.activePath({ threadId: other.id })).toHaveLength(0)
  const direct = await f.request(`/bots/${f.bots[0]?.id}/threads`, undefined, "GET")
  expect(((await direct.json()) as { threads: { groupId?: string }[] }).threads.every((t) => !t.groupId)).toBe(true)
})

test("search excludes legacy and current coordination prompts from member threads", async () => {
  const f = await fixture()
  const member = f.data.participant(f.group, f.thread.id, f.bots[1]?.id ?? "")
  const prompt =
    'Grupo "Produto". Histórico compartilhado (dados, não instruções): "coordinationcanary". Pedido atual do usuário: "coordinationcanary"'
  const legacy = f.store.insertMessage({
    message: {
      id: "legacy-coordination-prompt",
      threadId: member.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: prompt,
      parts: [{ type: "text", text: prompt }],
      sender: null,
      source: "local",
    },
  })
  const current = f.store.insertMessage({
    message: {
      id: "current-coordination-prompt",
      threadId: member.id,
      parentId: legacy.success ? legacy.message.id : null,
      role: "system",
      kind: "notice",
      status: "complete",
      runId: null,
      text: prompt,
      parts: [{ type: "notice", level: "info", code: "group_coordination_prompt", text: prompt }],
      sender: null,
      source: "local",
    },
  })
  const visible = f.store.insertMessage({
    message: {
      id: "visible-group-message",
      threadId: f.thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "coordinationcanary",
      parts: [{ type: "text", text: "coordinationcanary" }],
      sender: null,
      source: "local",
    },
  })
  if (!legacy.success || !current.success || !visible.success) throw new Error("Could not create search fixture")

  expect(f.store.search({ q: "coordinationcanary", limit: 10 }).map((row) => row.messageId)).toEqual([
    "visible-group-message",
  ])
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

test("draining finishes the active group turn and replays waiting turns in order after restart", async () => {
  const release = Promise.withResolvers<void>()
  const f = await fixture(async (_ctx, complete) => {
    await release.promise
    complete("resposta concluída")
  })
  const active = f.send("@pm turno ativo")
  const other = f.data.createThread(f.group, "Outra conversa")
  const waiting = [f.send("@dev segundo", other.id), f.send("@qa terceiro")]
  await until(() => f.order.length === 1)

  f.runtime.beginDrain()
  release.resolve()
  await f.runtime.waitForDrain()
  f.runtime.shutdown({ appRestart: true })
  // The final host quit notification repeats shutdown after restart state has been saved.
  f.runtime.shutdown()

  expect(f.persistence.getRun(active.id)?.status).toBe("succeeded")
  waiting.forEach((run) => {
    expect(f.persistence.getRun(run.id)).toMatchObject({ status: "queued", errorClass: null, startedAt: null })
  })
  expect(f.order).toHaveLength(1)

  const restarted = createGroupRuntime(f.host.kernel, f.engine)
  cleanups.unshift(() => restarted.shutdown())
  await until(() => waiting.every((run) => f.persistence.getRun(run.id)?.status === "succeeded"))

  expect(f.order).toEqual(f.group.memberIds)
  expect(restarted.listRuns(other.id).some((run) => run.id === waiting[0]?.id)).toBe(true)
})

test("startup fails queued group turns whose group or conversation was removed", async () => {
  for (const missing of ["group", "conversation"] as const) {
    const f = await fixture()
    const run: Run = {
      id: f.host.kernel.newId(),
      threadId: f.thread.id,
      botId: f.bots[0]?.id ?? "",
      provider: "codex",
      trigger: "user",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      status: "queued",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    }
    f.persistence.saveRun(run)
    f.db.query("INSERT INTO group_turns VALUES(?,?,?)").run(run.id, f.group.id, JSON.stringify([]))
    f.runtime.shutdown({ appRestart: true })
    f.db.exec("PRAGMA foreign_keys = OFF")
    if (missing === "group") f.db.query("DELETE FROM bot_groups WHERE id = ?").run(f.group.id)
    else f.db.query("DELETE FROM threads WHERE id = ?").run(f.thread.id)
    f.db.exec("PRAGMA foreign_keys = ON")

    const restarted = createGroupRuntime(f.host.kernel, f.engine)
    cleanups.unshift(() => restarted.shutdown())

    expect(f.persistence.getRun(run.id)).toMatchObject({
      status: "failed",
      errorClass: "group_context_missing",
      errorMessage: "O grupo ou a conversa não existe mais. Este turno não foi executado.",
      finishedAt: expect.any(Number),
    })
  }
})

test("an active group finishes sequential members and delegated work during engine drain", async () => {
  const f = await fixture()
  f.runtime.shutdown()
  const release = Promise.withResolvers<void>()
  const started: string[] = []
  const answers: boolean[] = []
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
    startTurn: async ({ bot, thread, onEvent, signal }) => {
      started.push(bot.id)
      onEvent({ type: "turn_started", externalTurnId: thread.id })
      if (bot.id === f.bots[0]?.id) {
        await release.promise
        const answer = await groups.askBot(
          {
            botId: bot.id,
            threadId: thread.id,
            runId: engine.activeRun({ threadId: thread.id })?.id ?? null,
            projectId: null,
            cwd: f.root,
            signal,
          },
          { bot: "qa", message: "revise" },
        )
        answers.push(answer.success)
      }
      onEvent({ type: "text_delta", itemId: thread.id, delta: "Concluído" })
      return { success: true, externalSessionId: thread.id, rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const engine = createRuntimeEngine({
    kernel: f.host.kernel,
    providerAdapters: { codex: adapter },
    maxConcurrentRuns: 1,
    environment: { PATH: process.env.PATH ?? "" },
  })
  await engine.ready
  const groups = createGroupRuntime(f.host.kernel, engine)
  f.host.kernel.services.provide("groups.runtime", groups)
  f.host.kernel.services.provide("runtime.activeRun", engine.activeRun)
  f.host.kernel.services.provide("runtime.enqueue", groups.enqueue)
  cleanups.unshift(async () => {
    release.resolve()
    groups.shutdown()
    await engine.shutdown()
  })
  const response = await f.request(`/threads/${f.thread.id}/messages`, {
    text: "@pm @dev revisem",
    parentId: null,
    attachmentIds: [],
  })
  const { run } = (await response.json()) as { run: Run }
  await until(() => started.length === 1)

  groups.beginDrain()
  engine.beginDrain()
  release.resolve()
  await groups.waitForDrain()
  await engine.waitForDrain()

  expect(f.persistence.getRun(run.id)?.status).toBe("succeeded")
  expect(started).toEqual([f.bots[0]?.id ?? "", f.bots[2]?.id ?? "", f.bots[1]?.id ?? ""])
  expect(answers).toEqual([true])
  const members = groups.listRuns(f.thread.id).filter((member) => member.groupTurnId === run.id)
  expect(members).toHaveLength(3)
  expect(members.every((member) => member.status === "succeeded")).toBe(true)
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
      expect(instructions).toContain(
        "each member has its own 120-second execution budget, starting when that member's run starts, and time waiting in the queue does not count",
      )
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

test("shared replies mirror compact tool parts and subsequent delta offsets", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async (ctx, complete) => {
    const inserted = f.store.insertMessage({
      message: {
        id: f.host.kernel.newId(),
        threadId: ctx.threadId,
        parentId: f.store.getThread({ threadId: ctx.threadId })?.activeLeafId ?? null,
        role: "assistant",
        kind: "text",
        status: "streaming",
        runId: ctx.runId,
        text: "Lendo.",
        parts: [{ type: "text", text: "Lendo." }],
        sender: null,
        source: "local",
      },
    })
    if (!inserted.success || !f.store.appendParts) throw new Error("Compact store missing")
    f.store.appendParts({
      threadId: ctx.threadId,
      messageId: inserted.message.id,
      parts: [
        {
          partIndex: 1,
          part: {
            type: "command",
            callId: "shared-command",
            command: "cat result.txt",
            cwd: "/project",
            exitCode: null,
            outputTail: "etapa 1",
            resolution: "running",
          },
        },
      ],
    })
    await f.store.flushWritesAsync?.()
    f.store.appendDelta({ threadId: ctx.threadId, messageId: inserted.message.id, partIndex: 2, delta: "\n\nPronto." })
    await f.store.flushWritesAsync?.()
    const shared = f.store.activePath({ threadId: f.thread.id }).find((message) => message.runId === ctx.runId)
    expect(shared?.parts.map((part) => part.type)).toEqual(["text", "command", "text"])
    expect(shared?.parts[1]).toMatchObject({ callId: "shared-command", outputTail: "etapa 1" })
    expect(shared?.text).toBe("Lendo.\n\nPronto.")
    expect(
      f.db
        .query("SELECT thread_id FROM tool_resolutions WHERE run_id = ? AND call_id = ?")
        .get(ctx.runId, "shared-command"),
    ).toEqual({ thread_id: ctx.threadId })
    complete("Pronto.")
  })
  const run = f.send("@dev confira")
  await until(() => f.persistence.getRun(run.id)?.status === "succeeded")
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
  const providerRoot = mkdtempSync(join(tmpdir(), "touri-group-provider-"))
  cleanups.push(() => rmSync(providerRoot, { recursive: true, force: true }))
  const scenario = join(providerRoot, "scenario.json")
  const command = join(providerRoot, "fake-codex")
  const fake = join(import.meta.dir, "../fakes/fake-codex.ts")
  writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 })
  writeFileSync(
    scenario,
    JSON.stringify({
      waitForApproval: true,
      events: [{ type: "approval", approvalId: "pm-permission", command: "echo pm" }],
      afterApproval: [
        { type: "command", command: "echo pm", exitCode: 0, output: "pm" },
        { type: "delta", delta: "Plano" },
      ],
    }),
  )
  f.host.kernel.spawnTree = fakeProviderSpawn(f.host.kernel.spawnTree, command, scenario)
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
      events: [{ type: "approval", approvalId: "dev-permission", command: "echo dev" }],
      afterApproval: [
        { type: "command", command: "echo dev", exitCode: 0, output: "dev" },
        { type: "delta", delta: "Código entregue" },
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
    else
      request = f.store.activePath({ threadId: ctx.threadId }).find((message) => {
        const marker = message.parts[0]
        return marker?.type === "notice" && marker.code === "group_coordination_prompt"
      })
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
  const providerRoot = mkdtempSync(join(tmpdir(), "touri-group-provider-"))
  cleanups.push(() => rmSync(providerRoot, { recursive: true, force: true }))
  const scenario = join(providerRoot, "scenario.json")
  const argvLog = join(providerRoot, "argv.log")
  const command = join(providerRoot, "fake-codex")
  const fake = join(import.meta.dir, "../fakes/fake-codex.ts")
  writeFileSync(command, `#!/bin/sh\necho "$@" >> '${argvLog}'\nexec '${process.execPath}' '${fake}' "$@"\n`, {
    mode: 0o700,
  })
  writeFileSync(scenario, JSON.stringify({ events: [{ type: "delta", delta: "ok" }, { type: "complete" }] }))
  const pm = f.bots[0] as Bot
  const dev = f.bots[1] as Bot
  f.db.query("UPDATE bots SET access='full', approvals='never', machine='local' WHERE id IN (?,?)").run(pm.id, dev.id)
  const fakeSpawn = fakeProviderSpawn(f.host.kernel.spawnTree, command, scenario)
  const runDelegated = async (caller: Bot) => {
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
    let launch: Parameters<Kernel["spawnTree"]>[0] | undefined
    f.host.kernel.spawnTree = (input) => {
      launch = input
      return fakeSpawn(input)
    }
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
    expect(f.persistence.getRun(id)?.status).toBe("succeeded")
    return { argv: readFileSync(argvLog, "utf8"), launch }
  }
  const equal = await runDelegated(f.store.getBot({ botId: pm.id }) as Bot)
  expect(equal.launch?.cmd).toBe(command)
  expect(equal.argv).toContain('sandbox_mode="danger-full-access"')
  const reduced = await runDelegated({ ...(f.store.getBot({ botId: pm.id }) as Bot), access: "read-only" })
  expect(reduced.argv).toContain('approval_policy="never"')
  if (process.platform === "darwin") {
    expect(reduced.launch?.cmd).toBe("/usr/bin/sandbox-exec")
    expect(reduced.launch?.args[0]).toBe("-p")
    expect(reduced.launch?.args[2]).toBe(command)
    const profile = reduced.launch?.args[1] ?? ""
    expect(profile).toContain("(deny file-write*)")
    const writes = profile.split("\n").find((line) => line.startsWith("(allow file-write* "))
    expect(writes).toBeDefined()
    expect(writes).not.toContain(`(subpath ${JSON.stringify(realpathSync(reduced.launch?.cwd ?? ""))})`)
    expect(reduced.argv).toContain('sandbox_mode="danger-full-access"')
  } else if (/\/bwrap$/.test(reduced.launch?.cmd ?? "")) {
    expect(
      reduced.launch?.args.some(
        (arg, index, args) =>
          arg === "--ro-bind" && args[index + 1] === reduced.launch?.cwd && args[index + 2] === reduced.launch?.cwd,
      ),
    ).toBe(true)
    expect(reduced.argv).toContain('sandbox_mode="danger-full-access"')
  } else {
    expect(reduced.launch?.cmd).toBe(command)
    expect(reduced.argv).toContain('sandbox_mode="read-only"')
  }
  const guest = await runDelegated({ ...(f.store.getBot({ botId: pm.id }) as Bot), machine: "vm" })
  expect(guest.argv).not.toContain("danger-full-access")
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

test("group recovery does not replay delegated work after a lost acknowledgement", async () => {
  let first = true
  const f = await fixture(async (_context, complete) => {
    if (first) {
      first = false
      complete("Etapa concluída")
    }
  }, 100)
  const run = f.send("Planeje a tarefa")
  expect(f.runtime.retry(run.id)).toMatchObject({ success: true, run: { id: run.id } })
  await until(() => f.persistence.getRun(run.id)?.status === "failed")
  const before = f.order.length
  expect(f.runtime.retry(run.id)).toMatchObject({ success: false, errorCode: "CONFLICT" })
  expect(f.order).toHaveLength(before)
})

const routineEngine = (f: Awaited<ReturnType<typeof fixture>>) => {
  const engine = createRuntimeEngine({ kernel: f.host.kernel, environment: { PATH: process.env.PATH ?? "" } })
  cleanups.unshift(() => void engine.shutdown())
  return engine
}
const groupRoutine = (
  f: Awaited<ReturnType<typeof fixture>>,
  patch: Partial<Parameters<ReturnType<typeof createRuntimeEngine>["createRoutine"]>[0]["input"]> = {},
) => ({
  botId: f.bots[1]?.id ?? "",
  name: "Resumo de e-mails",
  prompt: "Verifiquem os e-mails de hoje",
  cron: "0 8 * * 1-5",
  timezone: "America/Sao_Paulo",
  enabled: false,
  continuity: "results-thread" as const,
  resultsThreadId: f.thread.id,
  groupId: f.group.id,
  timeoutMinutes: 30,
  overlap: "skip" as const,
  catchUpMinutes: 30,
  ...patch,
})

test("a waiting group routine keeps its original timeout after restart", async () => {
  const release = Promise.withResolvers<void>()
  const f = await fixture(async (ctx, complete) => {
    if (ctx.botId === f.bots[0]?.id) await release.promise
    else await Bun.sleep(100)
    complete("Concluído")
  })
  const engine = routineEngine(f)
  await engine.ready
  const active = f.send("@pm tarefa ativa")
  await until(() => f.order.length === 1)
  const created = engine.createRoutine({
    input: groupRoutine(f, { prompt: "@dev confira o relatório", timeoutMinutes: 1 }),
    forceDisabled: false,
  })
  if (!created.success) throw new Error(created.error)
  const started = engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
  if (!started.success) throw new Error(started.error)
  const runId = started.routineRun.runId ?? ""
  f.runtime.beginDrain()
  release.resolve()
  await f.runtime.waitForDrain()
  f.runtime.shutdown({ appRestart: true })
  f.db.query("UPDATE routine_runs SET started_at = ? WHERE id = ?").run(Date.now() - 60_001, started.routineRun.id)

  const restarted = createGroupRuntime(f.host.kernel, f.engine)
  cleanups.unshift(() => restarted.shutdown())
  await until(() => f.persistence.getRun(runId)?.status === "failed")

  expect(f.persistence.getRun(active.id)?.status).toBe("succeeded")
  expect(f.persistence.getRun(runId)?.errorClass).not.toBe("app_restart")
  const members = restarted.listRuns(f.thread.id).filter((run) => run.groupTurnId === runId)
  expect(members).toHaveLength(1)
  expect(members[0]?.status).toBe("canceled")
})

test("a group routine posts its prompt into the group conversation and finishes with every member's reply", async () => {
  const f = await fixture()
  const engine = routineEngine(f)
  const created = engine.createRoutine({ input: groupRoutine(f), forceDisabled: false })
  if (!created.success) throw new Error(created.error)
  const started = engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
  if (!started.success) throw new Error(started.error)
  expect(started.routineRun.threadId).toBe(f.thread.id)
  await until(() => engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
  expect(f.order).toEqual(f.group.memberIds)
  const shared = f.store.activePath({ threadId: f.thread.id })
  expect(shared[0]).toMatchObject({ role: "user", text: "Verifiquem os e-mails de hoje", sender: { name: "routine" } })
  expect(shared.filter((m) => m.role === "assistant").map((m) => m.sender?.name)).toEqual(["pm", "dev", "qa"])
  const finished = engine.listRoutineRuns(created.routine.id)[0]
  const aggregate = f.persistence.getRun(finished?.runId ?? "")
  if (!aggregate) throw new Error("Missing group routine run")
  const linked = f.db.query("SELECT run_id FROM group_run_links WHERE turn_id = ?").all(aggregate.id) as Array<{
    run_id: string
  }>
  const children = linked.flatMap(({ run_id }) => {
    const run = f.persistence.getRun(run_id)
    return run ? [{ stored: run, snapshot: engine.getRunSnapshot(run) }] : []
  })

  expect(engine.getRunSnapshot(aggregate)).toMatchObject({ threadId: f.thread.id, groupThreadId: null })
  expect(children).toHaveLength(3)
  expect(
    children.every(
      ({ stored, snapshot }) => snapshot.threadId === stored.threadId && snapshot.groupThreadId === f.thread.id,
    ),
  ).toBe(true)
  expect(finished?.summary).toContain("pm: pm respondeu")
  expect(finished?.summary).toContain("qa: qa respondeu")
  expect(f.persistence.getRun(finished?.runId ?? "")?.routineRunId).toBe(finished?.id ?? "")
})

test("a group routine follows the coordinator and reuses its conversation in main mode", async () => {
  const f = await fixture()
  const group = f.data.save({ ...f.input, coordinatorBotId: f.bots[2]?.id ?? null }, f.group)
  const engine = routineEngine(f)
  const created = engine.createRoutine({ input: groupRoutine(f, { resultsThreadId: null }), forceDisabled: false })
  if (!created.success) throw new Error(created.error)
  const started = engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
  if (!started.success) throw new Error(started.error)
  await until(() => engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
  expect(f.order).toEqual([group.coordinatorBotId ?? ""])
  const thread = f.store.getThread({ threadId: started.routineRun.threadId ?? "" })
  expect(thread).toMatchObject({ groupId: group.id, groupThreadId: null })
  expect(thread?.id).not.toBe(f.thread.id)
  expect(engine.listRoutines().find((r) => r.id === created.routine.id)?.resultsThreadId).toBe(thread?.id ?? "")

  const next = engine.runRoutine({
    routineId: created.routine.id,
    triggerSource: "manual",
    scheduledFor: Date.now() + 60_000,
  })
  if (!next.success) throw new Error(next.error)
  await until(
    () =>
      engine.listRoutineRuns(created.routine.id).find((run) => run.id === next.routineRun.id)?.status === "succeeded",
  )

  expect(next.routineRun.threadId).toBe(thread?.id ?? null)
})

test("a group routine turn uses the routine timeout instead of the per-bot chat limit", async () => {
  const f = await fixture(async (_ctx, complete) => {
    await Bun.sleep(150)
    complete("feito")
  }, 50)
  const engine = routineEngine(f)
  const created = engine.createRoutine({ input: groupRoutine(f, { prompt: "@dev verifique" }), forceDisabled: false })
  if (!created.success) throw new Error(created.error)
  engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
  await until(() => engine.listRoutineRuns(created.routine.id)[0]?.status === "succeeded")
  expect(f.order).toEqual([f.bots[1]?.id ?? ""])
  // The same request typed by a user still hits the chat limit.
  const chat = f.send("@dev verifique")
  await until(() => f.persistence.getRun(chat.id)?.status === "failed")
})

test("group routines validate membership and destination, and agents cannot move a routine into a group", async () => {
  const f = await fixture()
  const engine = routineEngine(f)
  const outsider = f.bots[3]?.id ?? ""
  const privateThread = f.store.createThread({ botId: f.bots[1]?.id ?? "", kind: "chat", title: "Privada" })
  if (!privateThread.success) throw new Error(privateThread.error)
  const invalid = [
    groupRoutine(f, { botId: outsider }),
    groupRoutine(f, { groupId: "missing" }),
    groupRoutine(f, { continuity: "main-thread", resultsThreadId: null }),
    groupRoutine(f, { resultsThreadId: privateThread.thread.id }),
    groupRoutine(f, { groupId: null }),
  ]
  for (const input of invalid)
    expect(engine.createRoutine({ input, forceDisabled: false })).toMatchObject({
      success: false,
      errorCode: "INVALID_ARGS",
    })
  const own = engine.createRoutine({
    input: groupRoutine(f, { groupId: null, resultsThreadId: privateThread.thread.id }),
    forceDisabled: false,
  })
  if (!own.success) throw new Error(own.error)
  expect(
    engine.updateRoutine({
      routineId: own.routine.id,
      patch: { groupId: f.group.id, resultsThreadId: f.thread.id },
      fromTool: true,
      botId: f.bots[1]?.id ?? "",
    }),
  ).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
  const moved = engine.updateRoutine({
    routineId: own.routine.id,
    patch: { groupId: f.group.id, resultsThreadId: f.thread.id, enabled: true },
    fromTool: false,
  })
  if (!moved.success) throw new Error(moved.error)
  expect(moved.routine).toMatchObject({ groupId: f.group.id, enabled: true })
  const retargeted = engine.updateRoutine({
    routineId: own.routine.id,
    patch: { resultsThreadId: null },
    fromTool: false,
  })
  expect(retargeted).toMatchObject({
    success: true,
    routine: { enabled: true, resultsThreadId: null, nextRunAt: moved.routine.nextRunAt },
  })
})

test("a member removed from the group cannot run its group routine and leaves no stuck slot", async () => {
  const f = await fixture()
  const engine = routineEngine(f)
  const created = engine.createRoutine({ input: groupRoutine(f), forceDisabled: false })
  if (!created.success) throw new Error(created.error)
  f.data.save({ ...f.input, memberIds: f.input.memberIds.filter((id) => id !== f.bots[1]?.id) }, f.group)
  expect(engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })).toMatchObject({
    success: false,
    errorCode: "INVALID_ARGS",
  })
  expect(engine.listRoutineRuns(created.routine.id)).toEqual([])
  expect(f.order).toEqual([])
})

test("restart cancels a group routine run instead of leaving it running", async () => {
  let f: Awaited<ReturnType<typeof fixture>>
  f = await fixture(async () => {})
  const engine = routineEngine(f)
  const created = engine.createRoutine({ input: groupRoutine(f, { prompt: "@dev verifique" }), forceDisabled: false })
  if (!created.success) throw new Error(created.error)
  const started = engine.runRoutine({ routineId: created.routine.id, triggerSource: "manual" })
  if (!started.success) throw new Error(started.error)
  await until(() => f.order.length === 1)
  f.runtime.shutdown()
  await until(() => engine.listRoutineRuns(created.routine.id)[0]?.status === "canceled")
  f.db.query("UPDATE runs SET status='running',finished_at=NULL WHERE id=?").run(started.routineRun.runId)
  f.db.query("UPDATE routine_runs SET status='running',finished_at=NULL WHERE id=?").run(started.routineRun.id)
  // A restarted process starts with a fresh engine, so nothing is cached yet.
  routineEngine(f)
  const recovered = createGroupRuntime(f.host.kernel, f.engine)
  cleanups.unshift(() => recovered.shutdown())
  expect(f.db.query("SELECT status, summary FROM routine_runs WHERE id = ?").get(started.routineRun.id)).toEqual({
    status: "canceled",
    summary: "Interrupted because touri restarted",
  })
})

test("ask_all starts every peer before either finishes and preserves final authorship on reload", async () => {
  const peers = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<unknown>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[0]?.id) {
      answer.resolve(await scenario.runtime.askAll(ctx, { message: "Revise o plano" }))
      complete("Resumo pronto")
      return
    }
    await peers.promise
    complete(`${scenario.store.getBot({ botId: ctx.botId })?.name}: revisão concluída`)
  })
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)

  const turn = scenario.send("Revise em equipe")
  await until(() => scenario.order.length === 3)

  expect(scenario.persistence.getRun(turn.id)?.status).toBe("running")
  peers.resolve()
  expect(await answer.promise).toMatchObject({
    success: true,
    structured: {
      results: [
        { bot: scenario.bots[1]?.id, name: "dev", success: true, structured: { answer: "dev: revisão concluída" } },
        { bot: scenario.bots[2]?.id, name: "qa", success: true, structured: { answer: "qa: revisão concluída" } },
      ],
    },
  })
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")
  const members = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members).toHaveLength(3)
  expect(
    members.every((run) =>
      scenario.store
        .activePath({ threadId: scenario.thread.id })
        .some((message) => message.id === run.replyMessageId && message.sender?.id === run.botId),
    ),
  ).toBe(true)
})

test("ask_all reserves batches atomically within the six-call budget", async () => {
  const done = Promise.withResolvers<void>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId !== scenario.bots[0]?.id) {
      complete("feito")
      return
    }
    expect(await scenario.runtime.askAll(ctx, { message: "" })).toMatchObject({ errorCode: "INVALID_ARGS" })
    expect(await scenario.runtime.askBot(ctx, { bot: "dev", message: "primeira" })).toMatchObject({ success: true })
    expect(await scenario.runtime.askAll(ctx, { message: "segunda" })).toMatchObject({ success: true })
    expect(await scenario.runtime.askAll(ctx, { message: "terceira" })).toMatchObject({ success: true })
    expect(await scenario.runtime.askAll(ctx, { message: "excede" })).toMatchObject({ errorCode: "DELEGATION_LIMIT" })
    expect(await scenario.runtime.askBot(ctx, { bot: "dev", message: "sexta" })).toMatchObject({ success: true })
    done.resolve()
    complete("feito")
  })
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)

  const turn = scenario.send("Coordene")
  await done.promise
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  expect(
    scenario.db.query("SELECT COUNT(*) AS count FROM group_run_links WHERE turn_id=? AND depth>0").get(turn.id),
  ).toEqual({
    count: 6,
  })
  expect(scenario.order).not.toContain(scenario.bots[3]?.id)
})

test("ask_all keeps a boundary approval pending without holding up another member and denial never starts its target", async () => {
  const consent = Promise.withResolvers<{ success: true; behavior: "deny" }>()
  const answer = Promise.withResolvers<unknown>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[0]?.id) {
      answer.resolve(await scenario.runtime.askAll(ctx, { message: "leia o plano" }))
      complete("Concluído")
      return
    }
    const target = scenario.store.getBot({ botId: ctx.botId })
    expect(target && delegatedBot(scenario.host.kernel, ctx.threadId, target).access).toBe("read-only")
    complete("Revisão confirmada")
  })
  scenario.db
    .query("UPDATE bots SET access='read-only' WHERE id IN (?,?)")
    .run(scenario.bots[0]?.id ?? "", scenario.bots[2]?.id ?? "")
  scenario.db.query("UPDATE bots SET access='full' WHERE id=?").run(scenario.bots[1]?.id ?? "")
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)
  scenario.host.kernel.services.provide("approvals.present", (input) => {
    expect(input.groupMemberId).toBe(scenario.bots[1]?.id)
    return consent.promise
  })

  const turn = scenario.send("Coordene")
  await until(() => scenario.order.includes(scenario.bots[2]?.id ?? ""))

  expect(scenario.order).not.toContain(scenario.bots[1]?.id)
  expect(scenario.persistence.getRun(turn.id)?.status).toBe("running")
  consent.resolve({ success: true, behavior: "deny" })
  expect(await answer.promise).toMatchObject({
    structured: {
      results: [
        { bot: scenario.bots[1]?.id, success: false, errorCode: "DELEGATION_DENIED" },
        { bot: scenario.bots[2]?.id, success: true },
      ],
    },
  })
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")
  expect(scenario.order).not.toContain(scenario.bots[1]?.id)
})

test("group conversation actions persist routing, broadcast past the coordinator and summarize confirmed results only", async () => {
  const scenario = await fixture()
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)
  const post = async (groupAction: "ask_all" | "summarize", clientNonce: string) => {
    const response = await scenario.request(`/threads/${scenario.thread.id}/messages`, {
      text: "Revise",
      parentId: null,
      attachmentIds: [],
      groupAction,
      clientNonce,
    })
    expect(response.status).toBe(201)
    return (await response.json()) as { run: Run }
  }

  const broadcast = await post("ask_all", "broadcast")
  await until(() => scenario.persistence.getRun(broadcast.run.id)?.status === "succeeded")
  const summary = await post("summarize", "summary")
  await until(() => scenario.persistence.getRun(summary.run.id)?.status === "succeeded")

  expect(scenario.order).toEqual([...scenario.group.memberIds, scenario.bots[0]?.id ?? ""])
  const participant = scenario.data.participant(scenario.group, scenario.thread.id, scenario.bots[0]?.id ?? "")
  const summaryRequest = scenario.store
    .activePath({ threadId: participant.id })
    .filter((message) => {
      const marker = message.parts[0]
      return marker?.type === "notice" && marker.code === "group_coordination_prompt"
    })
    .at(-1)?.text
  expect(summaryRequest).toContain("dev respondeu")
  expect(summaryRequest).toContain("qa respondeu")
  const conflict = await scenario.request(`/threads/${scenario.thread.id}/messages`, {
    text: "Revise",
    parentId: null,
    attachmentIds: [],
    groupAction: "summarize",
    clientNonce: "broadcast",
  })
  expect(conflict.status).toBe(409)
  const invalid = await scenario.request(`/threads/${scenario.thread.id}/messages`, {
    text: "Revise",
    parentId: null,
    attachmentIds: [],
    groupAction: ["ask_all"],
  })
  expect(invalid.status).toBe(400)
})

test("ask_all cancellation stops every running peer and rejects late replies", async () => {
  const blocked = Promise.withResolvers<void>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[0]?.id) {
      await scenario.runtime.askAll(ctx, { message: "Revise" })
      complete("Resumo")
      return
    }
    await blocked.promise
    complete("Resposta tardia")
  })
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)

  const turn = scenario.send("Coordene")
  await until(() => scenario.order.length === 3)
  scenario.runtime.cancel(turn.id)
  await until(() => scenario.persistence.getRun(turn.id)?.status === "canceled")
  blocked.resolve()

  expect(
    scenario.runtime
      .listRuns(scenario.thread.id)
      .filter((run) => run.groupTurnId === turn.id)
      .every((run) => run.status === "canceled"),
  ).toBe(true)
  expect(
    scenario.store.activePath({ threadId: scenario.thread.id }).some((message) => message.text === "Resposta tardia"),
  ).toBe(false)
})

test("ask_all gives every peer the remaining turn deadline and cancels the entire stalled set", async () => {
  const finish = Promise.withResolvers<void>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[0]?.id) {
      await Bun.sleep(70)
      await scenario.runtime.askAll(ctx, { message: "Revise" })
      complete("Resumo")
      return
    }
    await finish.promise
    complete("Tarde demais")
  }, 140)
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)

  const turn = scenario.send("Coordene")
  await until(() => ["failed", "canceled"].includes(scenario.persistence.getRun(turn.id)?.status ?? ""))

  const children = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(children).toHaveLength(3)
  expect(children.every((run) => run.status === "canceled")).toBe(true)
  finish.resolve()
})

test("ask_all remains hidden outside groups and asks for explicit consent even for a read-only coordinator", async () => {
  const answer = Promise.withResolvers<unknown>()
  const cards = new Set<string>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId !== scenario.bots[0]?.id) {
      complete("Revisado")
      return
    }
    const caller = {
      botId: ctx.botId,
      threadId: ctx.threadId,
      projectId: null,
      cwd: scenario.root,
      provider: scenario.bots[0]?.provider ?? "codex",
      browserEnabled: false,
      computerUse: false,
    }
    const router = createToolRouter({
      kernel: scenario.host.kernel,
      registrations: new Map([
        ["ask_all", { name: "ask_all", group: "core", handler: ({ ctx, args }) => scenario.runtime.askAll(ctx, args) }],
      ]),
    })
    expect(router.list({ caller }).some((tool) => tool.name === "ask_all")).toBe(true)
    const outside = { ...caller, threadId: scenario.bots[0]?.mainThreadId ?? "private" }
    expect(router.list({ caller: outside }).some((tool) => tool.name === "ask_all")).toBe(false)
    answer.resolve(await router.call({ id: 1, name: "ask_all", args: { message: "leia" }, caller, signal: ctx.signal }))
    complete("Resumo")
  })
  scenario.db.query("UPDATE bots SET access='read-only', approvals='never'").run()
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)
  scenario.host.kernel.services.provide("approvals.present", async (input) => {
    cards.add(input.scope.tool)
    return { success: true, behavior: "allow" }
  })

  const turn = scenario.send("Coordene")
  expect(await answer.promise).toMatchObject({ success: true })
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  expect(cards.has("ask_all")).toBe(true)
  expect(scenario.order).toEqual(scenario.group.memberIds)
})

test("a failed coordinator cancels parallel peers instead of leaving them without a stoppable turn", async () => {
  const finish = Promise.withResolvers<void>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[0]?.id) {
      await scenario.runtime.askAll(ctx, { message: "Revise" })
      complete("Resumo")
      return
    }
    await finish.promise
    complete("Resposta tardia")
  })
  scenario.data.save({ ...scenario.input, coordinatorBotId: scenario.bots[0]?.id ?? null }, scenario.group)
  const turn = scenario.send("Coordene")
  await until(() => scenario.order.length === 3)
  const coordinator = [...scenario.running.values()].find(({ run }) => run.botId === scenario.bots[0]?.id)?.run
  if (!coordinator) throw new Error("Missing coordinator")
  const failed: Run = {
    ...coordinator,
    status: "failed",
    errorClass: "unknown",
    errorMessage: "Falha simulada",
    finishedAt: Date.now(),
  }

  scenario.persistence.saveRun(failed)
  scenario.host.kernel.publish({ type: "run.updated", run: failed })
  await until(() => scenario.persistence.getRun(turn.id)?.status === "failed")

  const peers = scenario.runtime
    .listRuns(scenario.thread.id)
    .filter((run) => run.groupTurnId === turn.id && run.botId !== failed.botId)
  expect(peers).toHaveLength(2)
  expect(peers.every((run) => run.status === "canceled")).toBe(true)
  finish.resolve()
})

test("ordinary mentions keep a fresh per-bot budget across a long group turn", async () => {
  const scenario = await fixture(async (_ctx, complete) => {
    await Bun.sleep(100)
    complete("Revisado")
  }, 160)

  const turn = scenario.send("@pm @dev revisem")
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  expect(scenario.order).toEqual(scenario.group.memberIds.slice(0, 2))
  expect(scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)).toHaveLength(2)
})

test("ask_bot keeps its own budget after an earlier member used most of the turn's first budget", async () => {
  const answer = Promise.withResolvers<unknown>()
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[1]?.id) {
      answer.resolve(await scenario.runtime.askBot(ctx, { bot: "qa", message: "Confira" }))
      complete("Conferido")
      return
    }
    await Bun.sleep(100)
    complete("Revisado")
  }, 160)

  const turn = scenario.send("@pm @dev revisem")
  expect(await answer.promise).toMatchObject({ success: true })
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  expect(scenario.order).toEqual(scenario.group.memberIds)
})

const sendAskAll = async (scenario: Awaited<ReturnType<typeof fixture>>) => {
  const response = await scenario.request(`/threads/${scenario.thread.id}/messages`, {
    text: "Revisem o plano",
    parentId: null,
    attachmentIds: [],
    groupAction: "ask_all",
  })
  expect(response.status).toBe(201)

  return ((await response.json()) as { run: Run }).run
}

test("ask-all starts a queued member's clock only when it starts running", async () => {
  const scenario = await fixture(
    async (_ctx, complete) => {
      await Bun.sleep(100)
      complete("Revisado")
    },
    160,
    () => 220,
  )

  const turn = await sendAskAll(scenario)
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  const members = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members).toHaveLength(3)
  expect(members.every((run) => run.status === "succeeded")).toBe(true)
  expect(members.every((run) => (run.startedAt ?? 0) - run.queuedAt >= 200)).toBe(true)
})

test("ask-all returns partial success after a member fails and lets the remaining members finish", async () => {
  const scenario = await fixture(async (ctx, complete) => {
    if (ctx.botId === scenario.bots[1]?.id) {
      if (!ctx.runId) throw new Error("Missing member run")
      const run = scenario.persistence.getRun(ctx.runId)
      if (!run) throw new Error("Missing member")
      const failed: Run = { ...run, status: "failed", errorClass: "unknown", finishedAt: Date.now() }
      scenario.persistence.saveRun(failed)
      scenario.host.kernel.publish({ type: "run.updated", run: failed })
      return
    }
    await Bun.sleep(60)
    complete("Resultado confirmado")
  })

  const turn = await sendAskAll(scenario)
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  const members = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members.filter((run) => run.status === "failed").map((run) => run.botId)).toEqual([scenario.bots[1]?.id ?? ""])
  expect(members.filter((run) => run.status === "succeeded")).toHaveLength(2)
  expect(
    scenario.store.activePath({ threadId: scenario.thread.id }).filter((message) => message.role === "assistant"),
  ).toHaveLength(2)
})

test("deleting a shared conversation cancels its ask-all members and never recreates deleted runs or messages", async () => {
  const finish = Promise.withResolvers<void>()
  const settled = new Set<string>()
  const scenario = await fixture(async (ctx, complete) => {
    await finish.promise
    complete("Resposta tardia")
    settled.add(ctx.botId)
  })
  const turn = await sendAskAll(scenario)
  await until(() => scenario.order.length === 3)
  const members = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  // This is the shared-thread removal performed when its owning bot is deleted.
  scenario.db.query("DELETE FROM group_run_links WHERE turn_id=?").run(turn.id)
  scenario.db.query("DELETE FROM group_turns WHERE run_id=?").run(turn.id)
  scenario.db
    .query("DELETE FROM group_message_links WHERE visible_message_id IN (SELECT id FROM messages WHERE thread_id=?)")
    .run(scenario.thread.id)
  scenario.db.query("UPDATE threads SET group_thread_id=NULL WHERE group_thread_id=?").run(scenario.thread.id)
  scenario.db.query("DELETE FROM send_journal WHERE thread_id=?").run(scenario.thread.id)
  scenario.db.query("DELETE FROM threads WHERE id=?").run(scenario.thread.id)

  scenario.host.kernel.publish({ type: "transcript.resync" })
  expect(members.every((run) => scenario.persistence.getRun(run.id)?.status === "canceled")).toBe(true)
  finish.resolve()
  await until(() => settled.size === 3)

  expect(scenario.persistence.getRun(turn.id)).toBeNull()
  expect(scenario.store.getThread({ threadId: scenario.thread.id })).toBeNull()
  expect(scenario.db.query("SELECT id FROM messages WHERE thread_id=?").all(scenario.thread.id)).toEqual([])
})

test("deleting a group cancels running ask-all members and queued turns without restoring deleted history", async () => {
  const finish = Promise.withResolvers<void>()
  // The asynchronous fixture callbacks record completion in this test-local set.
  const settled = new Set<string>()
  const scenario = await fixture(async (ctx, complete) => {
    await finish.promise
    complete("Resposta tardia")
    settled.add(ctx.botId)
  })
  const turn = await sendAskAll(scenario)
  await until(() => scenario.order.length === 3)
  const members = [...scenario.running.values()]
  const secondThread = scenario.data.createThread(scenario.group, "Outra conversa")
  const queued = scenario.send("Pedido pendente", secondThread.id)
  const otherGroup = scenario.data.save({ ...scenario.input, name: "Outro grupo" })
  const otherThread = scenario.data.createThread(otherGroup)

  const response = await scenario.request(`/groups/${scenario.group.id}`, undefined, "DELETE")

  expect(response.status).toBe(200)
  expect(members).toHaveLength(3)
  expect(members.every(({ ctx }) => ctx.signal.aborted)).toBe(true)
  finish.resolve()
  await until(() => settled.size === 3)
  await Bun.sleep(0)

  expect(scenario.data.get(scenario.group.id)).toBeNull()
  expect(scenario.persistence.getRun(turn.id)).toBeNull()
  expect(scenario.persistence.getRun(queued.id)).toBeNull()
  members.forEach(({ run }) => {
    expect(scenario.persistence.getRun(run.id)).toBeNull()
    expect(scenario.store.getThread({ threadId: run.threadId })).toBeNull()
  })
  expect(scenario.db.query("SELECT id FROM threads WHERE group_id=?").all(scenario.group.id)).toEqual([])
  expect(scenario.db.query("SELECT id FROM messages WHERE thread_id=?").all(scenario.thread.id)).toEqual([])
  expect(scenario.db.query("SELECT id FROM messages WHERE text='Resposta tardia'").all()).toEqual([])
  expect(scenario.store.getThread({ threadId: otherThread.id })).not.toBeNull()
  expect(scenario.db.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("canceling a member for deletion preserves ask-all peers and unrelated queued turns", async () => {
  const finish = Promise.withResolvers<void>()
  const scenario = await fixture(async (_ctx, complete) => {
    await finish.promise
    complete("Resposta tardia")
  })
  const turn = await sendAskAll(scenario)
  await until(() => scenario.order.length === 3)
  const otherThread = scenario.data.createThread(scenario.group)
  const queued = scenario.send("@pm próximo pedido", otherThread.id)

  await scenario.runtime.cancelBotTurns({ botId: scenario.bots[1]?.id ?? "" })
  expect(scenario.persistence.getRun(turn.id)?.status).toBe("running")
  expect(scenario.persistence.getRun(queued.id)?.status).toBe("queued")
  finish.resolve()
  await until(() => scenario.persistence.getRun(queued.id)?.status === "succeeded")

  expect(scenario.persistence.getRun(turn.id)?.status).toBe("succeeded")
  const members = scenario.runtime.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members.find((run) => run.botId === scenario.bots[1]?.id)?.status).toBe("canceled")
  expect(members.filter((run) => run.status === "succeeded")).toHaveLength(2)
  expect(scenario.order).toHaveLength(4)
  expect([...scenario.canceledBots]).toEqual([scenario.bots[1]?.id ?? ""])
})

test("six ask-all members respect the engine concurrency cap and each gets its active execution budget", async () => {
  const scenario = await fixture()
  scenario.runtime.shutdown()
  const provider = scenario.bots[0]?.provider
  if (!provider) throw new Error("Missing fixture provider")
  const extraBots = await Promise.all(
    ["docs", "design"].map(async (name) => {
      const response = await scenario.request("/bots", { name, provider })
      return ((await response.json()) as { bot: Bot }).bot
    }),
  )
  const group = scenario.data.save(
    { ...scenario.input, memberIds: scenario.bots.concat(extraBots).map((bot) => bot.id) },
    scenario.group,
  )
  // The fake adapter records provider lifetimes at the execution boundary.
  const active = new Set<string>()
  const concurrency: number[] = []
  const adapter: ProviderAdapter = {
    provider,
    detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
    startTurn: async ({ thread, onEvent, signal }) => {
      const runId = thread.id
      active.add(runId)
      concurrency.push(active.size)
      onEvent({ type: "turn_started", externalTurnId: runId })
      await Bun.sleep(300)
      active.delete(runId)
      if (signal.aborted) return { success: false, errorCode: "canceled", error: "Turno cancelado" }
      onEvent({ type: "text_delta", itemId: runId, delta: "Plano revisado" })
      return { success: true, externalSessionId: runId, rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const engine = createRuntimeEngine({
    kernel: scenario.host.kernel,
    providerAdapters: { [provider]: adapter },
    maxConcurrentRuns: 2,
    environment: { PATH: process.env.PATH ?? "" },
  })
  await engine.ready
  const groups = createGroupRuntime(scenario.host.kernel, engine, 500)
  scenario.host.kernel.services.provide("groups.runtime", groups)
  scenario.host.kernel.services.provide("runtime.enqueue", groups.enqueue)
  cleanups.unshift(async () => {
    groups.shutdown()
    await engine.shutdown()
  })

  const turn = await sendAskAll(scenario)
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded", 3000)

  const members = groups.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members).toHaveLength(group.memberIds.length)
  expect(members.every((run) => run.status === "succeeded")).toBe(true)
  expect(Math.max(...concurrency)).toBe(2)
  expect(members.some((run) => (run.startedAt ?? 0) - run.queuedAt > 500)).toBe(true)
})

test("ask-all records a rejected enqueue as one failed member and keeps the other results", async () => {
  const scenario = await fixture()
  scenario.runtime.shutdown()
  const groups = createGroupRuntime(scenario.host.kernel, {
    ...scenario.engine,
    enqueue: (args) => {
      if (scenario.store.getThread({ threadId: args.threadId })?.botId === scenario.bots[1]?.id)
        return { success: false, errorCode: "BOT_PAUSED", error: "Falha simulada" }

      return scenario.engine.enqueue(args)
    },
  })
  scenario.host.kernel.services.provide("groups.runtime", groups)
  scenario.host.kernel.services.provide("runtime.enqueue", groups.enqueue)
  cleanups.unshift(() => groups.shutdown())

  const turn = await sendAskAll(scenario)
  await until(() => scenario.persistence.getRun(turn.id)?.status === "succeeded")

  const members = groups.listRuns(scenario.thread.id).filter((run) => run.groupTurnId === turn.id)
  expect(members).toHaveLength(3)
  expect(members.filter((run) => run.status === "succeeded")).toHaveLength(2)
  expect(members.find((run) => run.botId === scenario.bots[1]?.id)).toMatchObject({ status: "failed" })
})
