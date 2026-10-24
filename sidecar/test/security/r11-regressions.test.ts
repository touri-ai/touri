import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, ToolRegistration, VmRuntime } from "@touri/contracts"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { createKernel } from "../../src/kernel"
import { createToolRouter } from "../../src/mcp/router"
import { darwinSandboxProfile } from "../../src/projects/darwinSandboxProfile"
import { init as initStore } from "../../src/store"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const fixture = async ({ access, approvals }: { access: string; approvals: string }) => {
  const root = mkdtempSync(join(tmpdir(), "touri-r11-regress-"))
  const runtime = createKernel({ appData: root })
  mkdirSync(join(root, "data"), { recursive: true })
  cleanup.push(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('project','test',?,?,1,1)").run(
    root,
    join(root, "data"),
  )
  db.query(
    "INSERT INTO bots(id,name,provider,machine,access,approvals,project_id,home_dir,created_at,updated_at) VALUES ('bot','test','codex','local',?,?,'project',?,1,1)",
  ).run(access, approvals, root)
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('thread','bot','chat','test',1,1)",
  ).run()
  const kernel: Kernel = runtime.kernel
  const caller = {
    botId: "bot",
    threadId: "thread",
    runId: null,
    projectId: "project",
    cwd: root,
    signal: new AbortController().signal,
    provider: "codex" as const,
    browserEnabled: true,
    computerUse: false,
  }
  return { root, db, kernel, caller }
}

const routerFor = ({ kernel, names }: { kernel: Kernel; names: Array<[string, string]> }) => {
  const counter = { calls: 0 }
  const registrations = new Map<string, ToolRegistration>(
    names.map(([name, group]) => [
      name,
      {
        name,
        group,
        handler: async () => {
          counter.calls++

          return { success: true, content: [] }
        },
      } as ToolRegistration,
    ]),
  )

  return { router: createToolRouter({ kernel, registrations }), counter }
}

const call = ({
  router,
  caller,
  name,
  args,
}: {
  router: ReturnType<typeof createToolRouter>
  caller: Awaited<ReturnType<typeof fixture>>["caller"]
  name: string
  args: unknown
}) => router.call({ id: 1, name, args, caller, signal: caller.signal })

const TAB = `t_${"0".repeat(26)}`

test("R11-REG-01 browser interaction and notifications do not prompt on default on-request bots", async () => {
  const f = await fixture({ access: "workspace-write", approvals: "on-request" })
  const { router, counter } = routerFor({
    kernel: f.kernel,
    names: [
      ["browser_navigate", "browser"],
      ["browser_click", "browser"],
      ["notify_user", "core"],
    ],
  })
  const navigate = await call({
    router,
    caller: f.caller,
    name: "browser_navigate",
    args: { tabId: TAB, url: "https://example.test" },
  })
  const click = await call({ router, caller: f.caller, name: "browser_click", args: { tabId: TAB, target: "4.43" } })
  const notify = await call({ router, caller: f.caller, name: "notify_user", args: { title: "a", body: "b" } })
  expect([navigate.success, click.success, notify.success]).toEqual([true, true, true])
  expect(counter.calls).toBe(3)
})

test("R11-REG-01 read-only bots keep browsing but cannot start host processes", async () => {
  const f = await fixture({ access: "read-only", approvals: "on-request" })
  const { router, counter } = routerFor({
    kernel: f.kernel,
    names: [
      ["browser_navigate", "browser"],
      ["process_start", "process"],
    ],
  })
  const navigate = await call({
    router,
    caller: f.caller,
    name: "browser_navigate",
    args: { tabId: TAB, url: "https://example.test" },
  })
  const start = await call({ router, caller: f.caller, name: "process_start", args: { name: "web" } })
  expect(navigate.success).toBe(true)
  expect(start).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(counter.calls).toBe(1)
})

const grantScope = { source: "claude" as const, tool: "Bash" }

const machineState = (machineId: string, authKeyId: string) => ({
  botId: "bot",
  status: "running",
  progress: null,
  error: null,
  memoryMb: 1024,
  createdMs: 1,
  startMs: 1,
  connection: {
    machineId,
    provider: "fixture",
    authKeyId,
    endpoints: { browser: "", bridge: "" },
    ports: [],
    display: { name: "fixture", width: 800, height: 600 },
    bridge: { guestPort: 1, socketPath: "", connectionFile: "" },
  },
})

test("R11-REG-02 VM standing grants survive a reboot (rotated key) and a stopped machine", async () => {
  const f = await fixture({ access: "workspace-write", approvals: "on-request" })
  f.db.query("UPDATE bots SET machine = 'vm' WHERE id = 'bot'").run()
  f.db
    .query("INSERT INTO bot_machines(bot_id, vm_id, volume) VALUES ('bot','touri-ns-abc','touri-ns-abc-workspace')")
    .run()
  let states = [machineState("touri-ns-abc", "boot-1")]
  f.kernel.services.provide("vm.runtime", { states: () => states } as unknown as VmRuntime)
  const grants = createStandingGrantStore(f.kernel)
  grants.add("bot", grantScope)
  expect(grants.has("bot", grantScope)).toBe(true)
  states = [machineState("touri-ns-abc", "boot-2")]
  expect(grants.has("bot", grantScope)).toBe(true)
  states = []
  expect(grants.list("bot")).toHaveLength(1)
  expect(grants.has("bot", grantScope)).toBe(true)
})

test("R11-REG-02 a grant is still dropped when the guest machine itself changes", async () => {
  const f = await fixture({ access: "workspace-write", approvals: "on-request" })
  f.db.query("UPDATE bots SET machine = 'vm' WHERE id = 'bot'").run()
  let states = [machineState("machine-a", "boot-1")]
  f.kernel.services.provide("vm.runtime", { states: () => states } as unknown as VmRuntime)
  const grants = createStandingGrantStore(f.kernel)
  grants.add("bot", grantScope)
  states = [machineState("machine-b", "boot-1")]
  expect(grants.has("bot", grantScope)).toBe(false)
})

test("R11-REG-03 grants saved before destinations existed are adopted, except host computer input", async () => {
  const f = await fixture({ access: "workspace-write", approvals: "on-request" })
  const legacy = [
    { id: "g1", botId: "bot", scope: grantScope, grantedAt: 1 },
    { id: "g2", botId: "bot", scope: { source: "computer", tool: "computer_key" }, grantedAt: 2 },
  ]
  const save = () =>
    f.db
      .query(
        "INSERT INTO settings(key,value_json,updated_at) VALUES ('approval-grants:bot',?,1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(JSON.stringify(legacy))
  save()
  const grants = createStandingGrantStore(f.kernel)
  expect(grants.list("bot").map((grant) => grant.id)).toEqual(["g1", "g2"])
  expect(grants.has("bot", grantScope)).toBe(true)
  f.db.query("UPDATE bots SET host_computer_use = 1 WHERE id = 'bot'").run()
  save()
  expect(grants.list("bot").map((grant) => grant.id)).toEqual(["g1"])
})

test("R11-REG-03 an unavailable bot lookup never erases saved grants", async () => {
  const f = await fixture({ access: "workspace-write", approvals: "on-request" })
  const grants = createStandingGrantStore(f.kernel)
  grants.add("bot", grantScope)
  f.db.query("PRAGMA foreign_keys = OFF").run()
  f.db.query("UPDATE bots SET id = 'moved' WHERE id = 'bot'").run()
  expect(grants.list("bot")).toHaveLength(0)
  f.db.query("UPDATE bots SET id = 'bot' WHERE id = 'moved'").run()
  expect(grants.list("bot")).toHaveLength(1)
})

test.skipIf(process.platform !== "darwin")(
  "R11-REG-04 local workspace-write processes can still redirect to /dev/null",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-r11-sandbox-"))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const profile = darwinSandboxProfile({ roots: [root] })
    const run = async (script: string) => {
      const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, "/bin/sh", "-c", script], {
        stdout: "pipe",
        stderr: "pipe",
      })

      return child.exited
    }
    expect(await run("echo ok > /dev/null; ls /nonexistent-r11 2>/dev/null; true")).toBe(0)
    expect(await run(`echo ok > ${join(root, "inside.txt")}`)).toBe(0)
    expect(await run(`echo no > ${join(tmpdir(), "touri-r11-outside.txt")}`)).not.toBe(0)
  },
)
