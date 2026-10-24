import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, HostMethods, Kernel, ToolContext } from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { createComputerController } from "../../src/computer/controller"
import { createComputerRoutes } from "../../src/computer/routes"
import { createComputerTools } from "../../src/computer/tools"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { createFakeHost } from "../fakes/fakeHost"

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "touri-wp7-"))

const seedBot = ({
  database,
  botId,
  threadId,
  computerUse,
}: {
  database: Database
  botId: string
  threadId: string
  computerUse: number
}): void => {
  database
    .query(
      `INSERT INTO bots (id, name, instructions, instructions_hash, provider, home_dir, computer_use, created_at, updated_at)
       VALUES (?, ?, '', '', 'codex', ?, ?, ?, ?)`,
    )
    .run(botId, botId, `/tmp/${botId}`, computerUse, Date.now(), Date.now())
  database
    .query("INSERT INTO threads (id, bot_id, kind, title, created_at, updated_at) VALUES (?, ?, 'chat', ?, ?, ?)")
    .run(threadId, botId, threadId, Date.now(), Date.now())
}

const context = ({ botId, threadId, cwd }: { botId: string; threadId: string; cwd: string }): ToolContext => ({
  botId,
  threadId,
  runId: null,
  projectId: null,
  cwd,
  signal: new AbortController().signal,
})

const installFakeHost = (kernel: Kernel) => {
  // These controller tests pre-grant a time window; the bridge confirms that test consent.
  kernel.services.provide("approvals.present", async ({ ctx, input }) => {
    const grant = (kernel.db as Database)
      .query("SELECT id FROM computer_grants WHERE bot_id = ? AND thread_id = ? AND revoked_at IS NULL")
      .get(ctx.botId, ctx.threadId)
    return grant
      ? { success: true, behavior: "allow", updatedInput: input }
      : { success: true, behavior: "deny", message: "Negado no teste" }
  })
  const fake = createFakeHost()
  const callHost: Kernel["callHost"] = async <M extends keyof HostMethods>(
    method: M,
    params: HostMethods[M]["params"],
  ) => {
    const value = await fake.methods[method](params)
    return { success: true, value }
  }
  kernel.callHost = callHost
  return fake
}

const tool = (controller: ReturnType<typeof createComputerController>, name: string) => {
  const registration = createComputerTools({ controller }).find((candidate) => candidate.name === name)
  if (!registration) throw new Error(`missing computer tool ${name}`)
  return registration.handler
}

test("computer tools use approval cards, scoped standing grants and revocation before host calls", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let controller: ReturnType<typeof createComputerController> | null = null
  let bridge: ReturnType<typeof createApprovalBridge> | null = null
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    const database = runtime.kernel.db as Database
    seedBot({ database, botId: "bot-a", threadId: "thread-a", computerUse: 1 })
    const cards: ApprovalPart[] = []
    bridge = createApprovalBridge({
      kernel: runtime.kernel,
      onCard: (_, part) => {
        cards.push(structuredClone(part))
        return true
      },
    })
    runtime.kernel.services.provide("approvals.present", bridge.present)
    controller = createComputerController(runtime.kernel, { sleep: async () => {} })
    const ctx = context({ botId: "bot-a", threadId: "thread-a", cwd: root })
    const type = tool(controller, "computer_type")
    let hostCalls = 0
    fake.methods["computer.type"] = async () => {
      hostCalls++
      return {}
    }
    const waiting = type({ ctx, args: { text: "Olá" } })
    while (!cards.length) await Bun.sleep(1)
    const card = cards[0]
    if (!card) throw new Error("Missing approval card")
    expect(hostCalls).toBe(0)
    expect(card.scope).toMatchObject({ source: "computer", tool: "computer_type" })
    expect(JSON.stringify(card.scope)).toContain('"destination"')
    await bridge.approve({ approvalId: card.approvalId, decision: "approved", standing: true })
    expect(await waiting).toMatchObject({
      success: true,
      content: [
        expect.objectContaining({ type: "text", text: "Aprovado: sempre para esta ferramenta neste bot." }),
        expect.anything(),
      ],
    })
    expect(await type({ ctx, args: { text: "De novo" } })).toMatchObject({
      success: true,
      content: [
        expect.objectContaining({
          type: "text",
          text: "Aprovado automaticamente pela permissão permanente desta ferramenta neste bot.",
        }),
        expect.anything(),
      ],
    })
    expect(hostCalls).toBe(2)
    const grants = createStandingGrantStore(runtime.kernel)
    expect(grants.list(ctx.botId)).toHaveLength(1)
    grants.revoke(ctx.botId, grants.list(ctx.botId)[0]?.id ?? "")
    const denied = type({ ctx, args: { text: "Negado" } })
    while (cards.at(-1)?.decision !== "pending") await Bun.sleep(1)
    await bridge.approve({ approvalId: cards.at(-1)?.approvalId ?? "", decision: "denied" })
    expect(await denied).toMatchObject({ success: false, error: "Negado pelo usuário." })
    expect(hostCalls).toBe(2)
    const changedMachine = type({ ctx, args: { text: "Mudança de máquina" } })
    while (cards.at(-1)?.decision !== "pending") await Bun.sleep(1)
    database.query("UPDATE bots SET machine = 'vm' WHERE id = 'bot-a'").run()
    expect(
      (await bridge.approve({ approvalId: cards.at(-1)?.approvalId ?? "", decision: "approved", standing: true }))
        .success,
    ).toBe(false)
    expect((await changedMachine).success).toBe(false)
    expect(grants.list(ctx.botId)).toEqual([])
    expect(hostCalls).toBe(2)
    database.query("UPDATE bots SET machine = 'local' WHERE id = 'bot-a'").run()
    database.query("UPDATE bots SET access = 'read-only' WHERE id = 'bot-a'").run()
    expect(await type({ ctx, args: { text: "Sem escrita" } })).toMatchObject({ success: false, errorCode: "DENIED" })
    expect(hostCalls).toBe(2)
  } finally {
    bridge?.dispose()
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("computer kill switch cancels an open card and cannot be bypassed by a standing grant", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let controller: ReturnType<typeof createComputerController> | null = null
  let bridge: ReturnType<typeof createApprovalBridge> | null = null
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    seedBot({ database: runtime.kernel.db as Database, botId: "bot-a", threadId: "thread-a", computerUse: 1 })
    const cards: ApprovalPart[] = []
    bridge = createApprovalBridge({
      kernel: runtime.kernel,
      onCard: (_, part) => {
        cards.push(structuredClone(part))
        return true
      },
    })
    runtime.kernel.services.provide("approvals.present", bridge.present)
    controller = createComputerController(runtime.kernel)
    const ctx = context({ botId: "bot-a", threadId: "thread-a", cwd: root })
    const screenshot = tool(controller, "computer_screenshot")
    fake.methods["permissions.status"] = async () => ({ accessibility: "denied", "screen-recording": "denied" })
    expect(await screenshot({ ctx, args: {} })).toMatchObject({ success: false, errorCode: "PERMISSION_MISSING" })
    expect(cards).toEqual([])
    fake.methods["permissions.status"] = async () => ({ accessibility: "granted", "screen-recording": "granted" })
    const pending = screenshot({ ctx, args: {} })
    while (!cards.length) await Bun.sleep(1)
    controller.handleHostNotification("computer.killSwitch")
    expect(await pending).toMatchObject({ success: false, errorCode: "COMPUTER_KILLED" })
    expect(cards.at(-1)?.decision).toBe("denied")
    expect(
      (await bridge.approve({ approvalId: cards[0]?.approvalId ?? "", decision: "approved", standing: true })).success,
    ).toBe(false)
    const grants = createStandingGrantStore(runtime.kernel)
    grants.add(ctx.botId, { source: "computer", tool: "computer_screenshot" })
    expect(await screenshot({ ctx, args: {} })).toMatchObject({ success: false, errorCode: "COMPUTER_KILLED" })
    expect(controller.isActive().active).toBe(false)
  } finally {
    bridge?.dispose()
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("computer tools enforce bot opt-in and time-boxed approval", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let controller: ReturnType<typeof createComputerController> | null = null
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    const database = runtime.kernel.db as Database
    seedBot({ database, botId: "bot-a", threadId: "thread-a", computerUse: 0 })
    controller = createComputerController(runtime.kernel, { grantWaitMs: 5 })
    const screenshot = tool(controller, "computer_screenshot")
    const ctx = context({ botId: "bot-a", threadId: "thread-a", cwd: root })

    const disabled = await screenshot({ ctx, args: {} })
    expect(disabled).toMatchObject({ success: false, errorCode: "COMPUTER_DISABLED" })

    database.query("UPDATE bots SET computer_use = 1 WHERE id = 'bot-a'").run()
    const notGranted = await screenshot({ ctx, args: {} })
    expect(notGranted).toMatchObject({ success: false, errorCode: "COMPUTER_NOT_GRANTED" })

    const grant = controller.grant({ botId: "bot-a", threadId: "thread-a", minutes: 5 })
    expect(grant).toMatchObject({ success: true })
    const forwarded = await screenshot({ ctx, args: { maxWidth: 1440 } })
    expect(forwarded.success).toBe(true)
    expect(fake.notifications).toEqual([])
  } finally {
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("computer lock, kill notification, expiry and state events are enforced", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let now = 1_000_000
  let controller: ReturnType<typeof createComputerController> | null = null
  try {
    await initStore(runtime.kernel)
    installFakeHost(runtime.kernel)
    const database = runtime.kernel.db as Database
    seedBot({ database, botId: "bot-a", threadId: "thread-a", computerUse: 1 })
    seedBot({ database, botId: "bot-b", threadId: "thread-b", computerUse: 1 })
    const events: Array<{ type: "computer.state"; active: boolean; botId: string | null; grantId: string | null }> = []
    const unsubscribe = runtime.kernel.subscribe((envelope) => {
      if (envelope.event.type === "computer.state") events.push(envelope.event)
    })
    controller = createComputerController(runtime.kernel, { now: () => now, grantWaitMs: 5 })
    const screenshot = tool(controller, "computer_screenshot")
    const ctxA = context({ botId: "bot-a", threadId: "thread-a", cwd: root })
    const ctxB = context({ botId: "bot-b", threadId: "thread-b", cwd: root })
    controller.grant({ botId: "bot-a", threadId: "thread-a", minutes: 5 })
    controller.grant({ botId: "bot-b", threadId: "thread-b", minutes: 5 })

    expect((await screenshot({ ctx: ctxA, args: {} })).success).toBe(true)
    expect(await screenshot({ ctx: ctxB, args: {} })).toMatchObject({ success: false, errorCode: "COMPUTER_BUSY" })

    controller.handleHostNotification("computer.killSwitch")
    expect(await screenshot({ ctx: ctxA, args: {} })).toMatchObject({ success: false, errorCode: "COMPUTER_KILLED" })
    expect(database.query("SELECT revoked_by FROM computer_grants WHERE bot_id = 'bot-a'").get()).toEqual({
      revoked_by: "kill-switch",
    })
    expect(events.some((event) => event.active && event.botId === "bot-a")).toBe(true)
    expect(events.at(-1)).toEqual({ type: "computer.state", active: false, botId: null, grantId: null })

    const renewed = controller.grant({ botId: "bot-a", threadId: "thread-a", minutes: 5 })
    expect(renewed.success).toBe(true)
    const renewedGrantId =
      renewed.success &&
      typeof renewed.structured === "object" &&
      renewed.structured !== null &&
      "id" in renewed.structured &&
      typeof renewed.structured.id === "string"
        ? renewed.structured.id
        : ""
    now += 6 * 60_000
    expect(controller.expire()).toBeGreaterThan(0)
    expect(database.query("SELECT revoked_by FROM computer_grants WHERE id = ?").get(renewedGrantId)).toEqual({
      revoked_by: "expiry",
    })
    unsubscribe()
  } finally {
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("computer routes grant only a matching bot thread and kill revokes all grants", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let controller: ReturnType<typeof createComputerController> | null = null
  try {
    await initStore(runtime.kernel)
    installFakeHost(runtime.kernel)
    const database = runtime.kernel.db as Database
    seedBot({ database, botId: "bot-a", threadId: "thread-a", computerUse: 1 })
    controller = createComputerController(runtime.kernel, { grantWaitMs: 5 })
    const routes = createComputerRoutes({ kernel: runtime.kernel, controller })
    const grantRoute = routes.routes.find((route) => route.path === "/computer/grants")
    const killRoute = routes.routes.find((route) => route.path === "/computer/kill")
    if (!grantRoute || !killRoute) throw new Error("computer routes missing")

    const invalid = await grantRoute.handler({
      params: {},
      query: {},
      body: { botId: "bot-a", threadId: "other", minutes: 30 },
      signal: new AbortController().signal,
    })
    expect(invalid.status).toBe(404)
    const granted = await grantRoute.handler({
      params: {},
      query: {},
      body: { botId: "bot-a", threadId: "thread-a", minutes: 30 },
      signal: new AbortController().signal,
    })
    expect(granted).toMatchObject({ status: 200, json: { expiresAt: expect.any(Number), grantId: expect.any(String) } })
    const forwarded = await tool(
      controller,
      "computer_screenshot",
    )({
      ctx: context({ botId: "bot-a", threadId: "thread-a", cwd: root }),
      args: {},
    })
    expect(forwarded.success).toBe(true)
    const killed = await killRoute.handler({ params: {}, query: {}, body: {}, signal: new AbortController().signal })
    expect(killed).toMatchObject({ status: 200, json: { revoked: 1 } })
    expect(
      await tool(
        controller,
        "computer_screenshot",
      )({
        ctx: context({ botId: "bot-a", threadId: "thread-a", cwd: root }),
        args: {},
      }),
    ).toMatchObject({ success: false, errorCode: "COMPUTER_NOT_GRANTED" })
  } finally {
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("computer kill cannot be undone by an in-flight activation", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  let controller: ReturnType<typeof createComputerController> | null = null
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    const database = runtime.kernel.db as Database
    seedBot({ database, botId: "bot-race", threadId: "thread-race", computerUse: 1 })
    const release = { activation: (): void => undefined }
    const activationStarted = new Promise<void>((resolve) => {
      release.activation = resolve
    })
    let activeCalls = 0
    fake.methods["computer.setActive"] = async ({ active }) => {
      activeCalls += 1
      if (active && activeCalls === 1) await activationStarted
      return {}
    }
    controller = createComputerController(runtime.kernel)
    controller.grant({ botId: "bot-race", threadId: "thread-race", minutes: 5 })
    let operationCalled = false
    const running = controller.execute({
      ctx: context({ botId: "bot-race", threadId: "thread-race", cwd: root }),
      operation: async () => {
        operationCalled = true
        return { success: true, content: [{ type: "text", text: "unexpected" }] }
      },
    })
    await Bun.sleep(10)
    controller.kill({ revokedBy: "kill-switch" })
    release.activation()
    expect(await running).toMatchObject({ success: false, errorCode: "COMPUTER_KILLED" })
    expect(operationCalled).toBe(false)
    expect(controller.isActive()).toEqual({ active: false, botId: null })
  } finally {
    controller?.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("B03: standing host grants cannot send keyboard or pointer input into touri or consent settings", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  const controller = createComputerController(runtime.kernel, { sleep: async () => {} })
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    seedBot({
      database: runtime.kernel.db as Database,
      botId: "protected",
      threadId: "protected-thread",
      computerUse: 1,
    })
    controller.grant({ botId: "protected", threadId: "protected-thread", minutes: 5 })
    const ctx = context({ botId: "protected", threadId: "protected-thread", cwd: root })
    await tool(controller, "computer_screenshot")({ ctx, args: {} })
    let posts = 0
    for (const name of ["computer.type", "computer.key", "computer.click", "computer.move", "computer.scroll"] as const)
      fake.methods[name] = async () => {
        posts++
        return {}
      }
    for (const bundleId of ["ai.touri.desktop", "com.apple.systempreferences"]) {
      fake.methods["computer.frontmost"] = async () => ({ app: "protected", bundleId, windowTitle: null })
      for (const [name, args] of [
        ["computer_type", { text: "approve" }],
        ["computer_key", { combo: "space" }],
        ["computer_click", { x: 0, y: 0 }],
        ["computer_scroll", { x: 0, y: 0, dy: 1 }],
      ] as const)
        expect(await tool(controller, name)({ ctx, args })).toMatchObject({ success: false })
    }
    expect(posts).toBe(0)
  } finally {
    controller.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("B03: terminal keyboard actions require exact one-shot consent despite a standing tool grant", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  const controller = createComputerController(runtime.kernel, { sleep: async () => {} })
  let bridge: ReturnType<typeof createApprovalBridge> | undefined
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    seedBot({ database: runtime.kernel.db as Database, botId: "terminal", threadId: "terminal-thread", computerUse: 1 })
    fake.methods["computer.frontmost"] = async () => ({
      app: "Terminal",
      bundleId: "com.apple.Terminal",
      windowTitle: null,
    })
    const cards: ApprovalPart[] = []
    bridge = createApprovalBridge({
      kernel: runtime.kernel,
      onCard: (_, part) => {
        cards.push(structuredClone(part))
        return true
      },
    })
    runtime.kernel.services.provide("approvals.present", bridge.present)
    createStandingGrantStore(runtime.kernel).add("terminal", { source: "computer", tool: "computer_type" })
    let posts = 0
    fake.methods["computer.type"] = async () => {
      posts++
      return {}
    }
    const ctx = context({ botId: "terminal", threadId: "terminal-thread", cwd: root })
    const result = tool(controller, "computer_type")({ ctx, args: { text: "echo safe" } })
    for (let i = 0; !cards.length && i < 20; i++) await Bun.sleep(1)
    expect(posts).toBe(0)
    expect(cards[0]).toMatchObject({ allowStanding: false, decision: "pending" })
    expect(cards[0]?.detail).toContain("echo safe")
    await bridge.approve({ approvalId: cards[0]?.approvalId ?? "", decision: "approved", standing: true })
    expect(await result).toMatchObject({ success: true })
    expect(posts).toBe(1)
    const denied = tool(controller, "computer_type")({ ctx, args: { text: "echo different" } })
    for (let i = 0; cards.filter((c) => c.decision === "pending").length < 2 && i < 20; i++) await Bun.sleep(1)
    const card = cards.at(-1)
    await bridge.approve({ approvalId: card?.approvalId ?? "", decision: "denied" })
    expect(await denied).toMatchObject({ success: false })
    expect(posts).toBe(1)
  } finally {
    bridge?.dispose()
    controller.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("B03: pointer input outside protected window bounds can focus another app after consent", async () => {
  const root = makeRoot()
  const runtime = createKernel({ appData: root })
  const controller = createComputerController(runtime.kernel, { sleep: async () => {} })
  try {
    await initStore(runtime.kernel)
    const fake = installFakeHost(runtime.kernel)
    seedBot({ database: runtime.kernel.db as Database, botId: "pointer", threadId: "pointer-thread", computerUse: 1 })
    controller.grant({ botId: "pointer", threadId: "pointer-thread", minutes: 5 })
    const ctx = context({ botId: "pointer", threadId: "pointer-thread", cwd: root })
    await tool(controller, "computer_screenshot")({ ctx, args: {} })
    fake.methods["computer.frontmost"] = async () => ({
      app: "touri",
      bundleId: "ai.touri.desktop",
      windowTitle: null,
      protectedRegions: [{ x: 0, y: 0, width: 400, height: 300 }],
    })
    let posts = 0
    fake.methods["computer.click"] = async () => {
      posts++
      return {}
    }
    expect(await tool(controller, "computer_click")({ ctx, args: { x: 500, y: 400 } })).toMatchObject({ success: true })
    expect(await tool(controller, "computer_click")({ ctx, args: { x: 200, y: 100 } })).toMatchObject({
      success: false,
    })
    expect(posts).toBe(1)
  } finally {
    controller.dispose()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
