import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ApprovalPart,
  Kernel,
  ProviderEvent,
  StartTurnArgs,
  ToolContext,
  ToolRegistration,
  VmRuntime,
} from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { createBrowserEngine } from "../../src/browser/engine"
import type { CdpClient } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"
import { flushFileIoAsync } from "../../src/kernel/async-files"
import { createRedactor } from "../../src/kernel/redact"
import { createToolRouter } from "../../src/mcp/router"
import { createProjectStore } from "../../src/projects/repository"
import { createSupervisor } from "../../src/projects/supervisor"
import { createProjectTools } from "../../src/projects/tools"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { init as initStore } from "../../src/store"
import { redactVmEvents } from "../../src/vm/redact-events"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-sec-tools-"))
  const runtime = createKernel({ appData: root })
  mkdirSync(join(root, "data"), { recursive: true })
  cleanup.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('project','test',?,?,1,1)").run(
    root,
    join(root, "data"),
  )
  db.query(
    "INSERT INTO bots(id,name,provider,machine,access,approvals,project_id,home_dir,created_at,updated_at) VALUES ('bot','test','codex','vm','workspace-write','on-request','project',?,1,1)",
  ).run(root)
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('thread','bot','chat','test',1,1)",
  ).run()
  db.query("UPDATE bots SET main_thread_id = 'thread' WHERE id = 'bot'").run()
  const vault = new Map<string, string>()
  let reads = 0
  let hostSpawns = 0
  let guestSpawns = 0
  let writes = 0
  const kernel: Kernel = {
    ...runtime.kernel,
    shellEnv: async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    spawnTree: () => {
      hostSpawns++
      return { success: false, errorCode: "SPAWN_FAILED", error: "fixture" }
    },
    callHost: (async (method: string, args: { account: string; value?: string }) => {
      if (method === "keychain.get") {
        reads++
        return { success: true, value: { value: vault.get(args.account) ?? null } }
      }
      if (method === "keychain.delete") {
        vault.delete(args.account)
        return { success: true, value: {} }
      }
      if (method === "keychain.set") {
        vault.set(args.account, args.value ?? "")
        return { success: true, value: {} }
      }
      return { success: true, value: { values: null } }
    }) as Kernel["callHost"],
  }
  kernel.services.provide("vm.runtime", {
    states: () => [],
    exec: async () => ({ success: true, code: 0, stdout: "", stderr: "" }),
    writeFile: async () => {
      writes++
    },
    acquire: async () => async () => {},
    spawn: () => {
      guestSpawns++
      return { success: false, errorCode: "SPAWN_FAILED", error: "fixture" }
    },
  } as unknown as VmRuntime)
  const cards: ApprovalPart[] = []
  const bridge = createApprovalBridge({
    kernel,
    timeoutMs: 200,
    onCard: (_, part) => {
      cards.push(structuredClone(part))
      return true
    },
  })
  cleanup.push(() => bridge.dispose())
  kernel.services.provide("approvals.present", bridge.present)
  const store = createProjectStore({ kernel })
  const supervisor = createSupervisor({ kernel, store })
  cleanup.push(() => supervisor.stopAll())
  const tools = createProjectTools({ kernel, store, supervisor, projectInfo: async () => null })
  const ctx: ToolContext = {
    botId: "bot",
    threadId: "thread",
    runId: null,
    projectId: "project",
    cwd: "/workspace",
    signal: new AbortController().signal,
  }
  const tool = (name: string, args: unknown) => {
    const registration = tools.find((t) => t.name === name)
    if (!registration) throw new Error("Missing tool")
    return registration.handler({ ctx, args })
  }
  const secret = (env = true) =>
    store.upsertSecret({
      projectId: "project",
      name: "API_KEY",
      usage: { env, browser: true },
      browserOrigin: "https://example.test",
      now: Date.now(),
    })
  return {
    root,
    runtime,
    kernel,
    db,
    vault,
    cards,
    bridge,
    store,
    supervisor,
    tools,
    ctx,
    tool,
    secret,
    counts: () => ({ reads, hostSpawns, guestSpawns, writes }),
  }
}

const browserFixture = async (f: Awaited<ReturnType<typeof fixture>>) => {
  let listener: (event: import("../../src/browser/types").CdpEvent) => void = () => {}
  const client: CdpClient = {
    call: async <T>(method: string, params?: import("../../src/browser/types").JsonObject) => {
      if (method === "Target.getTargets")
        return {
          targetInfos: [{ targetId: "page", type: "page", title: "fixture", url: "https://example.test/" }],
        } as T
      if (method === "Target.attachToTarget") return { sessionId: "page-session" } as T
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "")
        const value =
          expression === "location.origin"
            ? "https://example.test"
            : expression.includes("const body")
              ? {
                  url: "https://example.test/",
                  title: "fixture",
                  loading: false,
                  readyState: "complete",
                  text: "",
                  hasCanvas: false,
                  hasVideo: false,
                  crossOriginIframe: false,
                  viewport: { width: 800, height: 600, scrollY: 0, scrollHeight: 600 },
                  active: { role: "generic", name: "", backendNodeId: null },
                  mutationVersion: 0,
                }
              : []
        return { result: { value } } as T
      }
      return {} as T
    },
    subscribe: (callback) => {
      listener = callback
      return () => {}
    },
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: f.kernel,
    profile: "vm:bot",
    discoverBotId: "bot",
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  cleanup.push(() => engine.shutdown())
  await engine.list({ botId: "bot" })
  const tabId = engine.tabsForBot("bot")[0]?.tabId ?? ""
  const input = {
    tabId,
    botId: "bot",
    threadId: "thread",
    projectId: "project",
    fields: [],
    submit: "none" as const,
    signal: f.ctx.signal,
  }
  return {
    engine,
    input,
    navigate: (url: string) =>
      listener({ method: "Page.frameNavigated", params: { frame: { id: "top", url } }, sessionId: "page-session" }),
  }
}

test("A01/B01 built-in mutations reject read-only callers at the router boundary", async () => {
  const f = await fixture()
  f.db.query("UPDATE bots SET access = 'read-only' WHERE id = 'bot'").run()
  let calls = 0
  const registrations = new Map<string, ToolRegistration>(
    f.tools.map((t) => [
      t.name,
      {
        ...t,
        handler: async () => {
          calls++
          return { success: true, content: [] }
        },
      },
    ]),
  )
  const router = createToolRouter({ kernel: f.kernel, registrations })
  for (const [name, args] of [
    ["process_define", { name: "web", command: "echo exploited" }],
    ["process_start", { name: "web" }],
    ["env_write_file", { path: ".env", entries: { X: "ordinary" } }],
  ] as const) {
    const result = await router.call({
      id: 1,
      name,
      args,
      caller: { ...f.ctx, provider: "codex", browserEnabled: true, computerUse: false },
      signal: f.ctx.signal,
    })
    expect(result).toMatchObject({ success: false, errorCode: "DENIED" })
  }
  expect(calls).toBe(0)
})

test("A01/B01 on-request mutations wait for a card and recheck access before dispatch", async () => {
  const f = await fixture()
  let calls = 0
  const router = createToolRouter({
    kernel: f.kernel,
    registrations: new Map([
      [
        "process_define",
        {
          name: "process_define",
          group: "process",
          handler: async () => {
            calls++
            return { success: true, content: [] }
          },
        },
      ],
    ]),
  })
  const pending = router.call({
    id: 1,
    name: "process_define",
    args: { name: "web", command: "echo ok" },
    caller: { ...f.ctx, provider: "codex", browserEnabled: true, computerUse: false },
    signal: f.ctx.signal,
  })
  await Bun.sleep(5)
  expect(calls).toBe(0)
  expect(f.cards.length > 0).toBe(true)
  f.db.query("UPDATE bots SET access = 'read-only' WHERE id = 'bot'").run()
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "approved" })
  expect(await pending).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(calls).toBe(0)
})

test("A01/B01 a process definition changed while approval waits cannot execute", async () => {
  const f = await fixture()
  await f.tool("process_define", { name: "web", command: "echo reviewed" })
  let calls = 0
  const router = createToolRouter({
    kernel: f.kernel,
    registrations: new Map([
      [
        "process_start",
        {
          name: "process_start",
          group: "process",
          handler: async () => {
            calls++
            return { success: true, content: [] }
          },
        },
      ],
    ]),
  })
  const pending = router.call({
    id: 1,
    name: "process_start",
    args: { name: "web" },
    caller: { ...f.ctx, provider: "codex", browserEnabled: true, computerUse: false },
    signal: f.ctx.signal,
  })
  await Bun.sleep(5)
  f.db.query("UPDATE processes SET command = 'echo unreviewed' WHERE project_id = 'project'").run()
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "approved" })
  expect((await pending).success).toBe(false)
  expect(calls).toBe(0)
})

test("A09/B02 browser-only credentials cannot enter env files or process environments", async () => {
  const f = await fixture()
  f.secret(false)
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const written = await f.tool("env_write_file", { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } })
  expect(written.success).toBe(false)
  await f.tool("process_define", { name: "web", command: "echo ok", env: { TOKEN: { secret: "API_KEY" } } })
  const started = await f.tool("process_start", { name: "web", waitMs: 1 })
  expect(started.success).toBe(false)
  expect(f.counts().reads).toBe(0)
  expect(f.counts().writes).toBe(0)
})

test("A09/B02 malformed usage metadata fails closed even if consent is approved", async () => {
  const f = await fixture()
  f.secret(false)
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  f.db.query("UPDATE secrets SET usage_json = 'invalid' WHERE name = 'API_KEY'").run()
  f.kernel.services.provide("approvals.present", async () => ({ success: true, behavior: "allow" }))
  const exported = await f.tool("env_write_file", { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } })
  expect(exported.success).toBe(false)
  expect(f.counts().reads).toBe(0)
})

test("B08 env release waits for consent and denies changed secret configuration", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const pending = f.tool("env_write_file", { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } })
  await Bun.sleep(5)
  expect(f.counts().reads).toBe(0)
  expect(f.cards.length > 0).toBe(true)
  expect(JSON.stringify(f.cards).includes(f.vault.get("project/API_KEY") ?? "missing")).toBe(false)
  f.secret(false)
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "approved", standing: true })
  expect((await pending).success).toBe(false)
  expect(f.counts().writes).toBe(0)
})

test("B08 env grants allow only the same bot, secret and exact destination, and revocation is immediate", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const args = { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } }
  const first = f.tool("env_write_file", args)
  await Bun.sleep(5)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "approved", standing: true })
  expect((await first).success).toBe(true)
  const cardCount = f.cards.length
  expect((await f.tool("env_write_file", args)).success).toBe(true)
  expect(f.cards.length).toBe(cardCount)
  const otherPath = f.tool("env_write_file", { ...args, path: ".env.other" })
  await Bun.sleep(5)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "denied" })
  expect((await otherPath).success).toBe(false)
  f.db
    .query(
      "INSERT INTO bots(id,name,provider,machine,access,approvals,project_id,home_dir,created_at,updated_at) VALUES ('other','other','codex','vm','workspace-write','on-request','project',?,1,1)",
    )
    .run(f.root)
  f.db
    .query(
      "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('other-thread','other','chat','fixture',1,1)",
    )
    .run()
  f.ctx.botId = "other"
  f.ctx.threadId = "other-thread"
  const wrongBot = f.tool("env_write_file", args)
  await Bun.sleep(5)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "denied" })
  expect((await wrongBot).success).toBe(false)
  f.ctx.botId = "bot"
  f.ctx.threadId = "thread"
  const grants = createStandingGrantStore(f.kernel)
  for (const grant of grants.list("bot")) grants.revoke("bot", grant.id)
  const revoked = f.tool("env_write_file", args)
  await Bun.sleep(5)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "denied" })
  expect((await revoked).success).toBe(false)
  expect(f.counts().writes).toBe(2)
})

test("B08 pending env approval expires without releasing a value", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  expect((await f.tool("env_write_file", { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } })).success).toBe(
    false,
  )
  expect(f.cards.at(-1)?.decision).toBe("expired")
  expect(f.counts().reads).toBe(0)
  expect(f.counts().writes).toBe(0)
})

test("B08 credential-bearing destinations never persist values in cards or grants", async () => {
  const f = await fixture()
  f.secret()
  const value = "synthetic-test-credential"
  f.vault.set("project/API_KEY", value)
  f.kernel.addRedactionValue(value)
  const pending = f.tool("env_write_file", { path: `.env.${value}`, entries: { TOKEN: { secret: "API_KEY" } } })
  await Bun.sleep(5)
  expect(JSON.stringify(f.cards).includes(value)).toBe(false)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "approved", standing: true })
  expect((await pending).success).toBe(true)
  expect(JSON.stringify(createStandingGrantStore(f.kernel).list("bot")).includes(value)).toBe(false)
})

test("B08 env release rechecks metadata and grants after the asynchronous vault read", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const callHost = f.kernel.callHost
  f.kernel.callHost = (async (...args: Parameters<Kernel["callHost"]>) => {
    const result = await callHost(...args)
    if (args[0] === "keychain.get") f.secret(false)
    return result
  }) as Kernel["callHost"]
  const pending = f.tool("env_write_file", { path: ".env", entries: { TOKEN: { secret: "API_KEY" } } })
  await Bun.sleep(5)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "approved" })
  expect((await pending).success).toBe(false)
  expect(f.counts().writes).toBe(0)
})

test("A01/B01 supervised VM commands never use the host spawn boundary", async () => {
  const f = await fixture()
  expect((await f.tool("process_define", { name: "web", command: "echo ok" })).success).toBe(true)
  await f.tool("process_start", { name: "web", waitMs: 1 })
  expect(f.counts().guestSpawns).toBe(1)
  expect(f.counts().hostSpawns).toBe(0)
  f.db.query("UPDATE bots SET access = 'read-only' WHERE id = 'bot'").run()
  await f.tool("process_start", { name: "web", waitMs: 1 })
  expect(f.counts().guestSpawns).toBe(1)
})

test("A01/B01 local processes retain bot ownership and workspace writes require an OS sandbox", async () => {
  const f = await fixture()
  f.db.query("UPDATE bots SET machine = 'local' WHERE id = 'bot'").run()
  await f.tool("process_define", { name: "web", command: "echo ok" })
  const spec = f.store.getProcessSpecByName({ projectId: "project", name: "web" })
  expect(spec).not.toBeNull()
  let executable = ""
  f.kernel.spawnTree = ({ cmd }) => {
    executable = cmd
    return { success: false, errorCode: "SPAWN_FAILED", error: "fixture" }
  }
  await f.tool("process_start", { name: "web", waitMs: 1 })
  expect(executable === "" || executable.endsWith("sandbox-exec") || executable.endsWith("bwrap")).toBe(true)
  f.db
    .query("UPDATE settings SET value_json = ? WHERE key = ?")
    .run(JSON.stringify({ botId: "another-bot", machine: "local" }), `process-owner:${spec?.id ?? ""}`)
  expect((await f.tool("process_define", { name: "web", command: "echo replace" })).success).toBe(false)
  expect((await f.tool("process_start", { name: "web" })).success).toBe(false)
})

test("A01/B01 legacy agent processes require user adoption, then normal bot starts retain ownership", async () => {
  const f = await fixture()
  f.db.query("UPDATE bots SET machine = 'local', access = 'full' WHERE id = 'bot'").run()
  const project = f.store.getProject("project")
  if (!project) throw new Error("Missing project")
  const definition = {
    project,
    name: "legacy",
    command: "echo reviewed",
    cwd: f.root,
    env: {},
    autostart: false,
    restart: "never" as const,
    dependsOn: [],
    ready: null,
    previewPort: null,
  }
  const legacy = f.supervisor.define({ ...definition, createdBy: "agent" })
  expect(legacy.success).toBe(true)
  expect((await f.tool("process_start", { name: "legacy" })).success).toBe(false)
  const adopted = f.supervisor.define({ ...definition, createdBy: "user" })
  expect(adopted.success && adopted.spec.createdBy === "user").toBe(true)
  const started = await f.tool("process_start", { name: "legacy", waitMs: 1 })
  expect(!started.success && started.errorCode !== "DENIED").toBe(true)
  expect(f.counts().hostSpawns).toBe(1)
})

test.skipIf(process.platform !== "linux")(
  "A01/B01 project PATH and loader hooks cannot replace the sandbox launcher",
  async () => {
    const f = await fixture()
    f.db.query("UPDATE bots SET machine = 'local' WHERE id = 'bot'").run()
    await f.tool("process_define", {
      name: "web",
      command: "echo ok",
      env: { PATH: f.root, LD_PRELOAD: "/fixture/injected.so" },
    })
    let captured: Parameters<Kernel["spawnTree"]>[0] | null = null
    f.kernel.spawnTree = (input) => {
      captured = input
      return { success: false, errorCode: "SPAWN_FAILED", error: "fixture" }
    }
    const which = spyOn(Bun, "which").mockReturnValue("/usr/bin/bwrap")
    try {
      await f.tool("process_start", { name: "web", waitMs: 1 })
      const launch = captured as Parameters<Kernel["spawnTree"]>[0] | null
      expect(launch?.cmd).toBe("/usr/bin/bwrap")
      expect(launch?.env.LD_PRELOAD).toBeUndefined()
    } finally {
      which.mockRestore()
    }
  },
)

test("B08 saved browser injection waits for approval before reading the vault", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const client: CdpClient = {
    call: async <T>(method: string) =>
      (method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page", type: "page", title: "fixture", url: "https://example.test/" }] }
        : method === "Target.attachToTarget"
          ? { sessionId: "page-session" }
          : {}) as T,
    subscribe: () => () => {},
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: f.kernel,
    discoverBotId: "bot",
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  cleanup.push(() => engine.shutdown())
  await engine.list({ botId: "bot" })
  const tabId = engine.tabsForBot("bot")[0]?.tabId ?? ""
  const pending = engine.submitSecret({
    tabId,
    botId: "bot",
    threadId: "thread",
    projectId: "project",
    fields: [],
    secretName: "API_KEY",
    submit: "none",
    signal: f.ctx.signal,
  })
  await Bun.sleep(20)
  expect(f.counts().reads).toBe(0)
  expect(f.cards.length > 0).toBe(true)
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "denied" })
  expect((await pending).success).toBe(false)
})

test("B08 selecting a saved browser credential completes only after explicit consent", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const callHost = f.kernel.callHost
  f.kernel.callHost = (async (...args: Parameters<Kernel["callHost"]>) =>
    args[0] === "secret.prompt" ? await new Promise(() => {}) : callHost(...args)) as Kernel["callHost"]
  const browser = await browserFixture(f)
  const pending = browser.engine.submitSecret(browser.input)
  await Bun.sleep(5)
  const selection = browser.engine.secretEntry({ tabId: browser.input.tabId, secretName: "API_KEY", cancel: false })
  await Bun.sleep(5)
  expect(f.counts().reads).toBe(0)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "approved" })
  expect(await selection).toBe(true)
  expect((await pending).success).toBe(true)
  expect(f.counts().reads).toBe(1)
})

test("B08 navigation while saved browser consent waits denies without reading the vault", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const browser = await browserFixture(f)
  const pending = browser.engine.submitSecret({ ...browser.input, secretName: "API_KEY" })
  await Bun.sleep(5)
  browser.navigate("https://other.test/")
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "approved" })
  expect((await pending).success).toBe(false)
  expect(f.counts().reads).toBe(0)
})

test("A12 deleting a secret removes its vault account and prevents resurrection", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  expect((await f.store.deleteSecret({ projectId: "project", name: "API_KEY" })).success).toBe(true)
  expect(f.vault.has("project/API_KEY")).toBe(false)
  f.secret()
  expect(f.vault.has("project/API_KEY")).toBe(false)
})

test("A12 a failed vault deletion preserves recoverable metadata and invalidates grants", async () => {
  const f = await fixture()
  const created = f.secret()
  if (!created.success) throw new Error("Missing fixture secret")
  const grants = createStandingGrantStore(f.kernel)
  grants.add("bot", { source: "mcp", tool: "env_export", server: JSON.stringify(["saved-secret", created.secret.id]) })
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  f.kernel.callHost = (async () => ({
    success: false,
    errorCode: "HOST_ERROR",
    error: "fixture",
  })) as Kernel["callHost"]
  expect((await f.store.deleteSecret({ projectId: "project", name: "API_KEY" })).success).toBe(false)
  expect(f.store.getSecret({ projectId: "project", name: "API_KEY" }) !== null).toBe(true)
  expect(f.vault.has("project/API_KEY")).toBe(true)
  expect(grants.list("bot")).toHaveLength(0)
})

test("A12 deleting during a native secret prompt prevents a stale response from recreating the vault value", async () => {
  const f = await fixture()
  f.secret()
  f.vault.set("project/API_KEY", "synthetic-test-credential")
  const callHost = f.kernel.callHost
  let answer: (value: unknown) => void = () => {}
  f.kernel.callHost = (async (...args: Parameters<Kernel["callHost"]>) =>
    args[0] === "secret.prompt"
      ? await new Promise<unknown>((resolve) => {
          answer = resolve
        })
      : callHost(...args)) as Kernel["callHost"]
  const prompt = f.tool("secret_request", { name: "API_KEY", reason: "fixture" })
  await Bun.sleep(2)
  await f.store.deleteSecret({ projectId: "project", name: "API_KEY" })
  answer({ success: true, value: { values: { password: "synthetic-replacement" } } })
  expect((await prompt).success).toBe(false)
  expect(f.vault.has("project/API_KEY")).toBe(false)
  expect(f.store.getSecret({ projectId: "project", name: "API_KEY" })).toBeNull()
})

test("B04 guest standing computer consent cannot authorize host input", async () => {
  const f = await fixture()
  const input = {
    ctx: f.ctx,
    scope: { source: "computer" as const, tool: "computer_key" },
    toolName: "computer_key",
    input: { key: "Space" },
  }
  const first = f.bridge.present(input)
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "approved", standing: true })
  expect(await first).toMatchObject({ success: true, behavior: "allow" })
  f.db.query("UPDATE bots SET host_computer_use = 1 WHERE id = 'bot'").run()
  const second = f.bridge.present(input)
  expect(f.cards.at(-1)?.decision).toBe("pending")
  expect(f.cards.at(-1)?.approvalId === f.cards[0]?.approvalId).toBe(false)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "denied" })
  expect(await second).toMatchObject({ success: true, behavior: "deny" })
  expect(createStandingGrantStore(f.kernel).list("bot")).toHaveLength(0)
})

test("B04 standing computer grants expire when the guest machine identity changes", async () => {
  const f = await fixture()
  const vm = f.kernel.services.use("vm.runtime")
  if (!vm) throw new Error("Missing fake machine")
  let identity = "guest-a"
  vm.states = () => [
    {
      botId: "bot",
      status: "running",
      progress: null,
      error: null,
      memoryMb: 1024,
      createdMs: 1,
      startMs: 1,
      connection: {
        machineId: identity,
        provider: "fixture",
        authKeyId: identity,
        endpoints: { browser: "", bridge: "" },
        ports: [],
        display: { name: "fixture", width: 800, height: 600 },
        bridge: { guestPort: 1, socketPath: "", connectionFile: "" },
      },
    },
  ]
  const input = {
    ctx: f.ctx,
    scope: { source: "computer" as const, tool: "computer_key" },
    toolName: "computer_key",
    input: { key: "Space" },
  }
  const first = f.bridge.present(input)
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "approved", standing: true })
  expect(await first).toMatchObject({ success: true, behavior: "allow" })
  identity = "guest-b"
  const second = f.bridge.present(input)
  expect(f.cards.at(-1)?.decision).toBe("pending")
  expect(createStandingGrantStore(f.kernel).list("bot")).toHaveLength(0)
  await f.bridge.approve({ approvalId: f.cards.at(-1)?.approvalId ?? "", decision: "denied" })
  expect(await second).toMatchObject({ success: true, behavior: "deny" })
})

test("B07 live project credentials split across text and reasoning are masked before emission", () => {
  const redactor = createRedactor()
  const events: Array<{ type: string; delta?: string }> = []
  const emit = redactVmEvents({ secrets: [], redact: redactor.redact, emit: (event) => events.push(event) })
  const value = "synthetic-stream-credential"
  redactor.addRedactionValue(value)
  for (const type of ["text_delta", "reasoning_delta"] as const) {
    emit({ type, itemId: "item", delta: value.slice(0, 11) })
    emit({ type, itemId: "item", delta: value.slice(11) })
  }
  emit({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
  for (const type of ["text_delta", "reasoning_delta"])
    expect(
      events
        .filter((e) => e.type === type)
        .map((e) => e.delta)
        .join("")
        .includes(value),
    ).toBe(false)
})

test("B07 token-shaped and overlapping credentials retain the entire possible match", () => {
  for (const [value, split, shorter] of [
    ["sk-synthetic1234567890credential", 22, ""],
    ["synthetic-prefix-longer", 16, "synthetic-prefix"],
  ] as const) {
    const redactor = createRedactor()
    redactor.addRedactionValue(value)
    if (shorter) redactor.addRedactionValue(shorter)
    const deltas: string[] = []
    const emit = redactVmEvents({
      secrets: [],
      redact: redactor.redact,
      emit: (event) => {
        if (event.type === "text_delta") deltas.push(event.delta)
      },
    })
    emit({ type: "text_delta", itemId: "a", delta: `prefix ${value.slice(0, split)}` })
    emit({ type: "text_delta", itemId: "a", delta: `${value.slice(split)} suffix` })
    emit({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
    expect(deltas.join("") === "prefix [REDACTED] suffix").toBe(true)
  }
})

test("B07 overlapping full matches mask their entire union", () => {
  const redactor = createRedactor()
  redactor.addRedactionValue("abc")
  redactor.addRedactionValue("cde")
  const deltas: string[] = []
  const emit = redactVmEvents({
    secrets: [],
    redact: redactor.redact,
    emit: (event) => {
      if (event.type === "text_delta") deltas.push(event.delta)
    },
  })
  emit({ type: "text_delta", itemId: "item", delta: "ab" })
  emit({ type: "text_delta", itemId: "item", delta: "cde" })
  emit({ type: "turn_completed", status: "succeeded", errorClass: null, errorMessage: null })
  expect(deltas.join("") === "[REDACTED]").toBe(true)
})

test("B07 short credentials cannot corrupt provider event types or approval routing IDs", () => {
  const redactor = createRedactor()
  redactor.addRedactionValue("a")
  const events: ProviderEvent[] = []
  const emit = redactVmEvents({ secrets: [], redact: redactor.redact, emit: (event) => events.push(event) })
  emit({
    type: "approval_request",
    approvalId: "provider-a",
    part: { type: "approval", approvalId: "provider-a", request: "command", detail: "a", decision: "pending" },
  })
  emit({ type: "turn_completed", status: "failed", errorClass: "cli_auth", errorMessage: "a" })
  const first = events[0]
  expect(first?.type).toBe("approval_request")
  if (first?.type !== "approval_request") throw new Error("Corrupted event type")
  expect(first.approvalId).toBe("provider-a")
  expect(first.part.detail).toBe("[REDACTED]")
  expect(events[1]?.type).toBe("turn_completed")
})

test("A13 structured logs redact labels and registered JSON-escaped credentials", async () => {
  const f = await fixture()
  const value = 'synthetic-"quoted"\\credential\n'
  f.kernel.addRedactionValue(value)
  f.kernel.log({
    level: "info",
    module: "fixture",
    msg: "provider error",
    data: {
      nested: { detail: value, password: "unknown-synthetic-credential" },
      detail: "Authorization: Bearer unknown-synthetic-token",
    },
  })
  await flushFileIoAsync()
  const log = readFileSync(join(f.root, "logs/sidecar.log"), "utf8")
  expect(log.includes(JSON.stringify(value).slice(1, -1))).toBe(false)
  expect(log.includes("unknown-synthetic-credential")).toBe(false)
  expect(log.includes("unknown-synthetic-token")).toBe(false)
  const entries = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(entries).toContainEqual({
    at: expect.any(Number),
    level: "info",
    module: "fixture",
    msg: "provider error",
    data: {
      nested: { detail: "[REDACTED]", password: "[REDACTED]" },
      detail: "[REDACTED]",
    },
  })
})

test("A13 prefixed credential labels are redacted in structured and free-form diagnostics", () => {
  const redactor = createRedactor()
  expect(redactor.redact("AUTH_TOKEN=synthetic-prefixed-credential").includes("synthetic-prefixed-credential")).toBe(
    false,
  )
})

test("B06 Codex approval IDs are unique across children and expire when a child exits", async () => {
  const f = await fixture()
  const events: ProviderEvent[] = []
  const replies: Array<{ child: number; id: unknown }> = []
  const ends: Array<() => void> = []
  let nextChild = 0
  const spawn: Kernel["spawnTree"] = () => {
    const child = ++nextChild
    let output: ReadableStreamDefaultController<Uint8Array>
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        output = c
      },
    })
    const send = (value: unknown) =>
      setTimeout(() => {
        if (!ended) output.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
      }, 0)
    let resolveExit: (value: { code: number; signal: null }) => void = () => {}
    const exited = new Promise<{ code: number; signal: null }>((resolve) => {
      resolveExit = resolve
    })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      output.close()
      resolveExit({ code: 0, signal: null })
    }
    ends.push(end)
    return {
      success: true,
      pid: child,
      pgid: child,
      stdout,
      stderr: new ReadableStream({ start: (c) => c.close() }),
      extra: [],
      exited,
      kill: end,
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          const rpc = JSON.parse(new TextDecoder().decode(chunk)) as { id: unknown; method?: string; result?: unknown }
          if (rpc.method) {
            send({
              jsonrpc: "2.0",
              id: rpc.id,
              result: rpc.method === "thread/start" ? { thread: { id: `session-${child}` } } : {},
            })
            if (rpc.method === "turn/start")
              send({
                jsonrpc: "2.0",
                id: 42,
                method: "item/commandExecution/requestApproval",
                params: { approvalId: "provider-reused", command: "echo ok" },
              })
          } else replies.push({ child, id: rpc.id })
        },
      }),
    }
  }
  const adapter = createCodexAdapter({ kernel: f.kernel })
  cleanup.push(() => adapter.shutdown())
  const bot = f.kernel.services.use("store.api")?.getBot({ botId: "bot" })
  const thread = f.kernel.services.use("store.api")?.getThread({ threadId: "thread" })
  if (!bot || !thread) throw new Error("Missing fixture")
  const args = {
    bot,
    thread,
    execution: { spawn, writeFile: async () => {} },
    session: null,
    fingerprint: {
      cwd: "/workspace",
      provider: "codex",
      model: null,
      access: "workspace-write",
      approvals: "on-request",
      instructionsHash: "",
      toolsetVersion: "fixture",
      mcpServers: [],
    },
    input: [],
    developerInstructions: "",
    handoffPacket: null,
    mcp: { command: "fixture", args: [], env: {} },
    env: {},
    onEvent: (event: ProviderEvent) => events.push(event),
    signal: f.ctx.signal,
  } as StartTurnArgs
  const turns = [adapter.startTurn(args), adapter.startTurn(args)]
  for (let i = 0; i < 50 && events.filter((e) => e.type === "approval_request").length < 2; i++) await Bun.sleep(2)
  const ids = events
    .filter((e): e is Extract<ProviderEvent, { type: "approval_request" }> => e.type === "approval_request")
    .map((e) => e.approvalId)
  expect(ids).toHaveLength(2)
  expect(ids[0] === ids[1]).toBe(false)
  await adapter.answerApproval({ approvalId: ids[0] ?? "", decision: "approved" })
  expect(replies).toEqual([{ child: 1, id: 42 }])
  ends[1]?.()
  await Bun.sleep(5)
  expect(
    events.some(
      (event) => event.type === "approval_request" && event.approvalId === ids[1] && event.part.decision === "expired",
    ),
  ).toBe(true)
  expect(await adapter.answerApproval({ approvalId: ids[1] ?? "", decision: "approved" })).toMatchObject({
    success: false,
    errorCode: "NOT_FOUND",
  })
  ends[0]?.()
  await Promise.all(turns)
})
