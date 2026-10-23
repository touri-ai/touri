import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Bot, Run, ToolRegistration, VmRuntime } from "@touri/contracts"
import { validateToolArgs } from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { setDelegation } from "../../src/groups/security"
import { createKernel } from "../../src/kernel"
import { createToolRouter } from "../../src/mcp/router"
import { capabilitySupport } from "../../src/projects/capability-support"
import { createCapabilityTools } from "../../src/projects/capability-tools"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})

const fixture = async (patch: Partial<Bot> = {}, platform: NodeJS.Platform = "linux") => {
  const root = mkdtempSync(join(tmpdir(), "touri-capability-"))
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 0, stop: () => {} } as ReturnType<typeof Bun.serve>)
  const runtime = createKernel({ appData: root })
  serve.mockRestore()
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query(
    "INSERT INTO bots(id,name,provider,home_dir,browser_enabled,created_at,updated_at) VALUES ('b','Lia','codex',?,0,1,1)",
  ).run(join(root, "workspace"))
  db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
  db.exec(
    "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES ('r','t','b','codex','user','running',1)",
  )
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  if (patch.machine)
    db.query("UPDATE bots SET machine=? WHERE id='b'").run(patch.machine === "cloud" ? "local" : patch.machine)
  if (patch.machine === "cloud") db.exec("UPDATE bots SET cloud_target=1 WHERE id='b'")
  if (patch.access) db.query("UPDATE bots SET access=? WHERE id='b'").run(patch.access)
  if (patch.approvals) db.query("UPDATE bots SET approvals=? WHERE id='b'").run(patch.approvals)
  if (patch.browser) db.query("UPDATE bots SET browser=? WHERE id='b'").run(patch.browser)
  if (patch.browserEnabled) db.exec("UPDATE bots SET browser_enabled=1 WHERE id='b'")
  if (patch.hostComputerUse) db.exec("UPDATE bots SET host_computer_use=1 WHERE id='b'")
  const run: Run = {
    id: "r",
    botId: "b",
    threadId: "t",
    provider: "codex",
    trigger: "user",
    status: "running",
    routineRunId: null,
    requestMessageId: null,
    replyMessageId: null,
    externalTurnId: null,
    errorClass: null,
    errorMessage: null,
    usage: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: null,
  }
  runtime.kernel.services.provide("runtime.activeRun", () => run)
  let continuations = 0
  runtime.kernel.services.provide("runtime.continueAfterApproval", () => {
    continuations++
    return true
  })
  const cards: ApprovalPart[] = []
  const bridge = createApprovalBridge({
    kernel: runtime.kernel,
    timeoutMs: 1000,
    onCard: (_, part) => {
      cards.push(part)
      return true
    },
  })
  runtime.kernel.services.provide("approvals.present", bridge.present)
  const support: typeof capabilitySupport = (kernel, bot, capability) =>
    capabilitySupport(kernel, bot, capability, {
      platform,
      env: { TOURI_BROWSER_HEADLESS: "1" },
      which: () => "/test/browser",
      machineAvailable: () => true,
    })
  const registrations = new Map<string, ToolRegistration>(
    createCapabilityTools(runtime.kernel, support).map((tool) => [tool.name, tool]),
  )
  const router = createToolRouter({ kernel: runtime.kernel, registrations })
  const bot = () => store.getBot({ botId: "b" }) as Bot
  const caller = {
    botId: "b",
    threadId: "t",
    projectId: null,
    cwd: root,
    provider: "codex" as const,
    browserEnabled: false,
    computerUse: false,
  }
  const controller = new AbortController()
  const call = (capability = "browser", reason = "abrir a página solicitada") =>
    router.call({ id: 1, name: "capability_request", args: { capability, reason }, caller, signal: controller.signal })
  const answer = async (decision: "approved" | "denied", standing = false) => {
    for (let i = 0; i < 50 && !cards.length; i++) await Bun.sleep(5)
    const card = cards[0]
    if (!card) throw new Error("Missing card")
    return bridge.approve({ approvalId: card.approvalId, decision, standing })
  }
  cleanups.push(() => {
    bridge.dispose()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    db,
    run,
    bot,
    call,
    cards,
    answer,
    controller,
    router,
    caller,
    get continuations() {
      return continuations
    },
  }
}

test("browser activation always waits for consent, persists settings and requests one continuation", async () => {
  const f = await fixture({ browser: "local", access: "full", approvals: "never" })
  const grants = createStandingGrantStore(f.runtime.kernel)
  grants.add("b", { source: "mcp", server: "touri", tool: "capability_request" })
  const pending = f.call()
  await Bun.sleep(10)
  expect(f.bot()).toMatchObject({ browserEnabled: false, browser: "local", computerUse: false })
  expect(f.cards[0]).toMatchObject({ decision: "pending", allowStanding: false })
  expect(f.cards[0]?.detail).toContain('"botName":"Lia"')
  expect(await f.answer("approved", true)).toMatchObject({ success: true })
  expect(await pending).toMatchObject({
    success: true,
    structured: { capability: "browser", enabled: true, automaticContinuation: true },
  })
  expect(f.bot()).toMatchObject({ browserEnabled: true, browser: "touri", computerUse: false })
  expect(f.continuations).toBe(1)
  expect(f.cards.at(-1)).toMatchObject({ standing: false, decision: "approved" })
  expect(await f.call()).toMatchObject({ success: true, structured: { automaticContinuation: false } })
  expect(f.continuations).toBe(1)
})

test("denial leaves access disabled, explains settings and never schedules a continuation", async () => {
  const f = await fixture()
  const pending = f.call()
  await f.answer("denied")
  expect(await pending).toMatchObject({
    success: false,
    errorCode: "DENIED",
    error: expect.stringContaining("configurações deste bot"),
  })
  expect(f.bot().browserEnabled).toBe(false)
  expect(f.continuations).toBe(0)
})

for (const change of ["machine", "routing", "canceled", "run", "routine"] as const) {
  test(`pending consent cannot outlive a change to ${change}`, async () => {
    const f = await fixture()
    const pending = f.call()
    await Bun.sleep(10)
    if (change === "machine") f.db.exec("UPDATE bots SET machine='vm' WHERE id='b'")
    if (change === "routing") f.db.exec("UPDATE bots SET browser='local' WHERE id='b'")
    if (change === "canceled") f.controller.abort()
    if (change === "run") f.run.id = "new-run"
    if (change === "routine") f.run.routineRunId = "routine"
    await f.answer("approved")
    expect((await pending).success).toBe(false)
    expect(f.bot().browserEnabled).toBe(false)
    expect(f.continuations).toBe(0)
  })
}

for (const mode of ["delegated", "routine", "routine-retry", "import", "finished"] as const) {
  test(`${mode} runs cannot present capability approvals`, async () => {
    const f = await fixture()
    if (mode === "delegated")
      setDelegation(f.runtime.kernel, "t", {
        ceiling: f.bot(),
        caller: { id: "peer", name: "Peer" },
        groupThreadId: "peer-thread",
        secrets: false,
      })
    if (mode === "routine") f.run.trigger = "routine"
    if (mode === "routine-retry") {
      f.run.trigger = "retry"
      f.run.routineRunId = "routine"
    }
    if (mode === "import") f.run.trigger = "import"
    if (mode === "finished") f.run.status = "succeeded"
    expect(await f.call()).toMatchObject({ success: false, errorCode: "DENIED" })
    expect(f.cards).toHaveLength(0)
    expect(f.bot().browserEnabled).toBe(false)
  })
}

for (const machine of ["local", "cloud"] as const) {
  test(`unsupported ${machine} screen control is refused before approval`, async () => {
    const f = await fixture({ machine })
    expect(await f.call("computer_use")).toMatchObject({ success: false, errorCode: "UNSUPPORTED" })
    expect(f.cards).toHaveLength(0)
    expect(f.bot().computerUse).toBe(false)
  })
}

test("supported host computer setting requires a single explicit approval without a standing grant", async () => {
  const f = await fixture({}, "darwin")
  const pending = f.call("computer_use")
  await f.answer("approved", true)
  expect(await pending).toMatchObject({ success: true, structured: { automaticContinuation: true } })
  expect(f.bot()).toMatchObject({ computerUse: true, hostComputerUse: false, browserEnabled: false })
  expect(f.cards[0]?.allowStanding).toBe(false)
  expect(createStandingGrantStore(f.runtime.kernel).list("b")).toHaveLength(0)
})

test("isolated computer approval changes only its computer toggle", async () => {
  const f = await fixture({ machine: "vm" })
  f.runtime.kernel.services.provide("vm.runtime", { states: () => [] } as unknown as VmRuntime)
  const pending = f.call("computer_use")
  await f.answer("approved")
  expect((await pending).success).toBe(true)
  expect(f.bot()).toMatchObject({ computerUse: true, machine: "vm", hostComputerUse: false, browserEnabled: false })
})

test("platform support requires the execution environment and keeps Linux host control hidden", async () => {
  const f = await fixture()
  const support = (capability: "browser" | "computer_use", env = {}) =>
    capabilitySupport(f.runtime.kernel, f.bot(), capability, { platform: "linux", env, which: () => "/test/browser" })
  expect(support("computer_use")).toContain("não é suportado")
  expect(support("browser")).toBeNull()
  expect(support("browser", { TOURI_BROWSER_HEADLESS: "1" })).toBeNull()
  expect(
    capabilitySupport(f.runtime.kernel, f.bot(), "browser", {
      platform: "linux",
      env: { DISPLAY: ":1" },
      which: () => null,
    }),
  ).toContain("não está instalado")
  expect(
    capabilitySupport(f.runtime.kernel, f.bot(), "computer_use", { platform: "darwin", env: { TOURI_HEADLESS: "1" } }),
  ).toContain("não é suportado")
  const original = { bin: process.env.TOURI_CHROME_BIN, headless: process.env.TOURI_BROWSER_HEADLESS }
  process.env.TOURI_CHROME_BIN = process.execPath
  process.env.TOURI_BROWSER_HEADLESS = "1"
  try {
    const tool = f.router.list({ caller: f.caller }).find((tool) => tool.name === "capability_request")
    if (process.platform === "linux")
      expect(tool?.inputSchema).toMatchObject({ properties: { capability: { enum: ["browser"] } } })
  } finally {
    if (original.bin === undefined) delete process.env.TOURI_CHROME_BIN
    else process.env.TOURI_CHROME_BIN = original.bin
    if (original.headless === undefined) delete process.env.TOURI_BROWSER_HEADLESS
    else process.env.TOURI_BROWSER_HEADLESS = original.headless
  }
})

test("catalog rejects missing, unknown, empty and oversized capability requests", () => {
  for (const args of [
    {},
    { capability: "all", reason: "test" },
    { capability: "browser", reason: " " },
    { capability: "browser", reason: "x".repeat(241) },
    { capability: "browser", reason: "test", botId: "peer" },
  ])
    expect(validateToolArgs({ name: "capability_request", args }).success).toBe(false)
})

test("unsupported cloud browser and unavailable isolated computer cannot request approval", async () => {
  for (const machine of ["cloud", "vm"] as const) {
    const f = await fixture({ machine })
    expect(await f.call("browser")).toMatchObject({ success: false, errorCode: "UNSUPPORTED" })
    expect(f.cards).toHaveLength(0)
    expect(f.bot().browserEnabled).toBe(false)
  }
})

test("browser reason rejects line breaks and control characters before presenting consent", async () => {
  const f = await fixture()
  for (const reason of ["abrir\na página", "abrir\u0000página"]) {
    expect(await f.call("browser", reason)).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
    expect(f.cards).toHaveLength(0)
  }
})

test("isolated browser approval selects the bot's machine browser without enabling computer control", async () => {
  const f = await fixture({ machine: "vm" })
  f.runtime.kernel.services.provide("vm.runtime", { states: () => [] } as unknown as VmRuntime)
  const pending = f.call("browser")
  await f.answer("approved")
  expect((await pending).success).toBe(true)
  expect(f.bot()).toMatchObject({
    browserEnabled: true,
    browser: "machine",
    computerUse: false,
    hostComputerUse: false,
  })
})

test("an isolated bot cannot use a stale host-control choice to enable Linux host access", async () => {
  const f = await fixture({ machine: "vm", hostComputerUse: true })
  f.runtime.kernel.services.provide("vm.runtime", { states: () => [] } as unknown as VmRuntime)
  expect(await f.call("computer_use")).toMatchObject({ success: false, errorCode: "UNSUPPORTED" })
  expect(f.cards).toHaveLength(0)
  expect(f.bot().computerUse).toBe(false)
})
