import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Bot, Routine, ToolContext, ToolRegistration } from "@touri/contracts"
import { toolPresentation } from "../../../ui/src/components/toolPresentation"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { createKernel } from "../../src/kernel"
import { createToolRouter } from "../../src/mcp/router"
import { getHost } from "../../src/platform/host"
import { init as initRuntime } from "../../src/runtime"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const fixture = async (approvals: Bot["approvals"] = "never") => {
  const root = mkdtempSync(join(tmpdir(), "touri-routine-activation-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        "x-touri-client": "routine-test",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const response = await request("POST", "/bots", {
    name: "Resumo QA",
    provider: "codex",
    machine: "local",
    approvals,
  })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }
  const tools = new Map<string, ToolRegistration>()
  const register = runtime.kernel.registerTools
  runtime.kernel.registerTools = (input) => {
    for (const tool of input.tools) tools.set(tool.name, tool)
    return register(input)
  }
  await initRuntime(runtime.kernel)
  // Seed an in-progress chat without starting any provider process. The real
  // approval bridge must persist its card on this run and accept the UI response.
  const db = runtime.kernel.db as Database
  const runId = "routine-chat-run"
  const threadId = bot.mainThreadId ?? ""
  db.query(
    "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,request_message_id,queued_at) VALUES (?,?,?,'codex','user','running','routine-chat-request',?)",
  ).run(runId, threadId, bot.id, Date.now())
  db.query(
    "INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at) VALUES ('routine-chat-request',?,'user','text','Todo dia às 9h, no horário de São Paulo, me mande aqui um resumo',?,?)",
  ).run(threadId, Date.now(), Date.now())
  const persistence = createRuntimePersistence({ database: db })
  runtime.kernel.services.provide("runtime.activeRun", ({ threadId: requestedThread }) =>
    requestedThread === threadId ? persistence.getRun(runId) : null,
  )
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const cards = (): ApprovalPart[] => {
    return store
      .activePath({ threadId })
      .flatMap((message) =>
        message.runId === runId ? message.parts.filter((part): part is ApprovalPart => part.type === "approval") : [],
      )
  }
  const publishedCards: ApprovalPart[] = []
  const unsubscribe = runtime.kernel.subscribe(({ event }) => {
    const parts =
      event.type === "message.created" || event.type === "message.updated"
        ? event.message.parts
        : event.type === "message.parts"
          ? event.parts.map(({ part }) => part)
          : []
    for (const part of parts) if (part.type === "approval") publishedCards.push(structuredClone(part))
  })
  const controller = new AbortController()
  const ctx: ToolContext = {
    botId: bot.id,
    threadId,
    runId,
    projectId: null,
    cwd: bot.homeDir,
    signal: controller.signal,
  }
  const tool = tools.get("routine_create")
  if (!tool) throw new Error("Missing routine tool")
  const call = (context: ToolContext = ctx, overrides: Record<string, unknown> = {}) =>
    tool.handler({
      ctx: context,
      args: {
        name: "Resumo diário QA",
        prompt: "Me mande aqui um resumo",
        cron: "0 9 * * *",
        timezone: "America/Sao_Paulo",
        continuity: "main-thread",
        ...overrides,
      },
    })
  const gatewayCall = (overrides: Record<string, unknown> = {}) =>
    createToolRouter({ kernel: runtime.kernel, registrations: tools }).call({
      id: 1,
      name: "routine_create",
      args: {
        name: "Resumo diário QA",
        prompt: "Me mande aqui um resumo",
        cron: "0 9 * * *",
        timezone: "America/Sao_Paulo",
        continuity: "main-thread",
        ...overrides,
      },
      caller: {
        botId: bot.id,
        threadId,
        projectId: bot.projectId,
        cwd: bot.homeDir,
        provider: bot.provider,
        browserEnabled: false,
        computerUse: false,
      },
      signal: controller.signal,
    })
  const routine = async () =>
    ((await (await request("GET", "/routines")).json()) as { routines: Routine[] }).routines[0]
  cleanups.push(async () => {
    unsubscribe()
    await runtime.kernel.services.use("runtime.shutdown")?.()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { runtime, request, bot, cards, publishedCards, controller, call, gatewayCall, routine, tools, ctx }
}

test("chat-created daily routines require an inline approval even with approvals off and a standing grant", async () => {
  const f = await fixture()
  createStandingGrantStore(f.runtime.kernel).add(f.bot.id, { source: "mcp", server: "touri", tool: "routine_create" })
  const result = f.gatewayCall()
  await Bun.sleep(0)
  expect(f.cards()).toHaveLength(1)
  const card = f.cards()[0]
  if (!card) throw new Error("Missing approval")
  expect(card).toMatchObject({ decision: "pending", allowStanding: false })
  expect(card.detail).toContain("Resumo diário QA")
  expect(card.detail).toContain("0 9 * * *")
  expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
  const response = await f.request("POST", `/approvals/${card.approvalId}`, { decision: "approved", standing: true })
  expect(response.status).toBe(200)
  expect(f.publishedCards.filter((part) => part.approvalId === card.approvalId).at(-1)).toMatchObject({
    decision: "approved",
    standing: false,
  })
  expect(f.cards()[0]).toMatchObject({ decision: "approved", standing: false })
  expect(await result).toMatchObject({ success: true, structured: { enabled: true, continuity: "main-thread" } })
  const routine = await f.routine()
  expect(routine?.nextRunAt).toBeGreaterThan(Date.now())
  if (!routine?.nextRunAt) throw new Error("Missing next execution")
  expect(
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(
      routine.nextRunAt,
    ),
  ).toBe("09:00")
})

test.each(["a", '"', "\u0000"])(
  "an 8,000-character prompt (%j) keeps the activation review complete across the real bridge",
  async (character) => {
    const f = await fixture()
    const prompt = character.repeat(8000)
    const result = f.call(f.ctx, { prompt })
    const card = f.cards()[0]
    if (!card) throw new Error("Missing activation approval")
    try {
      expect(card.detail.length).toBeLessThan(8000)
      const review = JSON.parse(card.detail.slice("routine_create: ".length))
      expect(review).toMatchObject({
        name: "Resumo diário QA",
        schedule: "Todo dia às 09:00 · horário de São Paulo",
        timezone: "America/Sao_Paulo",
        promptPreview: `${character.repeat(512)}…`,
        promptLength: 8000,
      })
      expect(review.prompt).toBeUndefined()
      const presentation = toolPresentation(undefined, card)
      expect(presentation.name).toBe("Ativar rotina")
      expect(presentation.summary).toContain("Resumo diário QA · Todo dia às 09:00 · horário de São Paulo")
      expect(presentation.code).toContain("Tamanho completo: 8000 caracteres")
      expect(presentation.approvalLabel).toBe("Ativar rotina “Resumo diário QA”")
      expect(await f.routine()).toMatchObject({ enabled: false, prompt })
      await f.request("POST", `/approvals/${card.approvalId}`, { decision: "approved" })
      expect(await result).toMatchObject({ success: true, structured: { enabled: true, prompt } })
    } finally {
      f.controller.abort()
      await result
    }
  },
)

test("oversized schedule metadata refuses activation instead of delivering a cut review", async () => {
  const f = await fixture()
  const result = f.call(f.ctx, { cron: `${"0,".repeat(4000)}0 9 * * *` })
  try {
    expect(f.cards()).toHaveLength(0)
    expect(await result).toMatchObject({ success: true, structured: { enabled: false } })
    expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
  } finally {
    f.controller.abort()
    await result
  }
})

test.each(["denied", "canceled", "changed"] as const)("a %s activation never enables the routine", async (action) => {
  const f = await fixture()
  const result = f.call()
  const card = f.cards()[0]
  expect(card).toBeDefined()
  if (!card) throw new Error("Missing approval")
  if (action === "canceled") f.controller.abort()
  else {
    if (action === "changed") {
      const routine = await f.routine()
      await f.request("PATCH", `/routines/${routine?.id}`, { cron: "0 10 * * *" })
    }
    await f.request("POST", `/approvals/${card.approvalId}`, { decision: action === "denied" ? "denied" : "approved" })
  }
  await result
  expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
  expect((f.runtime.kernel.db as Database).query("SELECT count(*) AS count FROM routine_runs").get()).toEqual({
    count: 0,
  })
})

test("a routine stays paused when its approval cannot be delivered to a live chat", async () => {
  const f = await fixture()
  await f.call({ ...f.ctx, runId: null })
  expect(f.cards()).toHaveLength(0)
  expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
})

test("the update tool still cannot bypass routine activation approval", async () => {
  const f = await fixture()
  await f.call({ ...f.ctx, runId: null })
  const routine = await f.routine()
  const update = f.tools.get("routine_update")
  if (!update || !routine) throw new Error("Missing routine or tool")
  const result = await update.handler({ ctx: f.ctx, args: { routineId: routine.id, enabled: true } })
  expect(result).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
  expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
})

test("the gateway preserves the existing creation approval before offering activation", async () => {
  const f = await fixture("on-request")
  const prompt = "a".repeat(8000)
  const result = f.gatewayCall({ prompt })
  await Bun.sleep(0)
  const creation = f.cards()[0]
  if (!creation) throw new Error("Missing creation approval")
  const review = JSON.parse(creation.detail.slice("routine_create: ".length))
  expect(review).toMatchObject({ promptPreview: `${prompt.slice(0, 512)}…`, promptLength: 8000 })
  expect(review.prompt).toBeUndefined()
  expect(await f.routine()).toBeUndefined()
  await f.request("POST", `/approvals/${creation.approvalId}`, { decision: "approved" })
  const activation = f.cards()[1]
  if (!activation) throw new Error("Missing activation approval")
  expect(activation.approvalId).not.toBe(creation.approvalId)
  expect(activation.detail).toContain("routineId")
  expect(await f.routine()).toMatchObject({ enabled: false, nextRunAt: null })
  await f.request("POST", `/approvals/${activation.approvalId}`, { decision: "approved" })
  expect(await result).toMatchObject({ success: true, structured: { enabled: true, prompt } })
})

test("the gateway still denies routine creation for read-only bots", async () => {
  const f = await fixture()
  await f.request("PATCH", `/bots/${f.bot.id}`, { access: "read-only" })
  expect(await f.gatewayCall()).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(f.cards()).toHaveLength(0)
  expect(await f.routine()).toBeUndefined()
})

test("the routine editor preserves its reviewed destination, recovery window and scheduler host", async () => {
  const f = await fixture()
  const listing = (await (await f.request("GET", "/routines")).json()) as { hostKind: string }
  expect(listing.hostKind).toBe(getHost())
  const response = await f.request("POST", "/routines", {
    botId: f.bot.id,
    name: "Organizar notas",
    prompt: "Organize as notas desta conversa",
    cron: "0 9 * * 1-5",
    timezone: "America/Sao_Paulo",
    enabled: true,
    continuity: "results-thread",
    resultsThreadId: f.bot.mainThreadId,
    timeoutMinutes: 20,
    catchUpMinutes: 45,
    overlap: "skip",
  })
  expect(response.status).toBe(201)
  const { routine } = (await response.json()) as { routine: Routine }
  expect(routine).toMatchObject({
    enabled: true,
    resultsThreadId: f.bot.mainThreadId,
    catchUpMinutes: 45,
    timeoutMinutes: 20,
  })
  expect(routine.nextRunAt).toBeGreaterThan(Date.now())
  const edited = await f.request("PATCH", `/routines/${routine.id}`, { prompt: "Organize outras notas" })
  expect(edited.status).toBe(200)
  expect(await edited.json()).toMatchObject({
    routine: { enabled: true, nextRunAt: routine.nextRunAt, prompt: "Organize outras notas" },
  })
  const changed = await f.request("PATCH", `/routines/${routine.id}`, { resultsThreadId: null, enabled: true })
  expect(changed.status).toBe(200)
  expect(await changed.json()).toMatchObject({ routine: { resultsThreadId: null, enabled: true } })
  const invalid = await f.request("PATCH", `/routines/${routine.id}`, { resultsThreadId: "another-conversation" })
  expect(invalid.status).toBe(400)
})
