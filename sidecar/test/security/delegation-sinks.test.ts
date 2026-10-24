import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ToolRegistration } from "@touri/contracts"
import { delegationCeiling, setDelegation } from "../../src/groups/security"
import { createKernel } from "../../src/kernel"
import { refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { createToolRouter } from "../../src/mcp/router"
import { createProjectStore } from "../../src/projects/repository"
import { createSupervisor } from "../../src/projects/supervisor"
import { createProjectTools } from "../../src/projects/tools"
import { init as initStore } from "../../src/store"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const sandboxHost = process.platform === "darwin" || process.platform === "linux"

const fixture = async (callerMachine: "local" | "vm") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-delegation-sinks-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "touri-fake-home-")))
  const runtime = createKernel({ appData: join(root, "app") })
  const dataDir = join(runtime.kernel.paths.projectsDir, "p")
  mkdirSync(join(root, "project"), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(root, "home"), { recursive: true })
  cleanup.push(async () => {
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('p','t',?,?,1,1)").run(
    join(root, "project"),
    dataDir,
  )
  const insert = db.query(
    "INSERT INTO bots(id,name,provider,machine,access,approvals,project_id,home_dir,created_at,updated_at) VALUES (?,?,'codex',?,?,?,'p',?,1,1)",
  )
  insert.run(
    "caller",
    "caller",
    callerMachine,
    "workspace-write",
    callerMachine === "vm" ? "on-request" : "never",
    join(root, "home"),
  )
  insert.run("target", "target", "local", "full", "never", join(root, "home"))
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('tt','target','chat','t',1,1)",
  ).run()
  const kernel: Kernel = runtime.kernel
  kernel.services.provide("approvals.present", (async () => ({ success: true, behavior: "allow" })) as never)
  const store = createProjectStore({ kernel })
  const supervisor = createSupervisor({ kernel, store })
  cleanup.push(() => supervisor.stopAll())
  const tools = createProjectTools({ kernel, store, supervisor, projectInfo: async () => null })
  const registrations = new Map<string, ToolRegistration>(tools.map((tool) => [tool.name, tool]))
  const router = createToolRouter({ kernel, registrations })
  const bots = (id: string): Bot => {
    const bot = kernel.services.use("store.api")?.getBot({ botId: id })
    if (!bot) throw new Error("missing bot")
    return bot
  }
  const delegate = (): void =>
    setDelegation(kernel, "tt", {
      ceiling: bots("caller"),
      caller: { id: "caller", name: "caller" },
      groupThreadId: "g",
      secrets: false,
    })
  const call = (name: string, args: unknown) =>
    router.call({
      id: Math.random(),
      name,
      args,
      caller: {
        botId: "target",
        threadId: "tt",
        projectId: "p",
        cwd: join(root, "project") as never,
        provider: "codex",
        browserEnabled: true,
        computerUse: false,
      },
      signal: new AbortController().signal,
    })
  const callAs = (botId: string, threadId: string, name: string, args: unknown) =>
    router.call({
      id: Math.random(),
      name,
      args,
      caller: {
        botId,
        threadId,
        projectId: "p",
        cwd: join(root, "project") as never,
        provider: "codex",
        browserEnabled: true,
        computerUse: false,
      },
      signal: new AbortController().signal,
    })
  const registerEvaluate = (): { count: () => number } => {
    let count = 0
    registrations.set("browser_evaluate", {
      name: "browser_evaluate",
      group: "browser",
      handler: async () => {
        count++
        return { success: true, content: [] }
      },
    })
    db.query("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('experimentalTools','true',1)").run()
    db.query("UPDATE bots SET browser_enabled = 1").run()
    return { count: () => count }
  }
  return { root, outside, kernel, delegate, call, callAs, bots, db, tools, registerEvaluate }
}

const runEscape = async (f: Awaited<ReturnType<typeof fixture>>, file: string): Promise<boolean> => {
  const completed = join(f.root, "project", file)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const command = `touch ${quote(join(f.outside, file))}; touch ${quote(completed)} && echo COMPLETED; sleep 60`
  expect(
    await f.call("process_define", { name: file, command, restart: "never", ready: { logRegex: "COMPLETED" } }),
  ).toMatchObject({ success: true })
  const started = await f.call("process_start", { name: file, waitMs: 5000 })
  const logs = await f.call("process_logs", { name: file })
  expect({ started, logs }).toMatchObject({ started: { success: true }, logs: { success: true } })
  expect(existsSync(completed)).toBe(true)
  return existsSync(join(f.outside, file))
}

test.skipIf(!sandboxHost)(
  "R13-B02: full local access reaches outside the project while delegation enforces the ceiling",
  async () => {
    expect(await refreshHostFolderAccess()).toBe(true)
    const control = await fixture("local")
    expect(control.bots("target").access).toBe("full")
    expect(await runEscape(control, "control")).toBe(true)
    control.db
      .query("UPDATE bots SET folders_json = ? WHERE id = 'target'")
      .run(JSON.stringify([{ path: control.outside, access: "read-only" }]))
    expect(await runEscape(control, "saved-grant")).toBe(true)
    const f = await fixture("local")
    f.delegate()
    expect(delegationCeiling(f.bots("caller"), f.bots("target")).access).toBe("workspace-write")
    expect(await runEscape(f, "escaped")).toBe(false)
    expect(f.bots("target").access).toBe("full")
  },
  30_000,
)

test.skipIf(!sandboxHost)(
  "R13-B02: guest-to-host delegation keeps the workspace-write sandbox at the supervisor",
  async () => {
    expect(await refreshHostFolderAccess()).toBe(true)
    const f = await fixture("vm")
    f.delegate()
    expect(await runEscape(f, "escaped")).toBe(false)
  },
  30_000,
)

test("R13-B04: process_logs and project_info only reach processes the caller owns", async () => {
  const f = await fixture("local")
  f.db
    .query(
      "INSERT INTO bots(id,name,provider,machine,access,approvals,project_id,home_dir,created_at,updated_at) VALUES ('other','other','codex','local','workspace-write','never','p',?,1,1)",
    )
    .run(f.root)
  f.db
    .query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('ot','other','chat','t',1,1)")
    .run()
  expect(
    (await f.call("process_define", { name: "secretapp", command: "echo confidential", restart: "never" })).success,
  ).toBe(true)
  expect(await f.callAs("target", "tt", "process_logs", { name: "secretapp" })).toMatchObject({ success: true })
  expect(await f.callAs("other", "ot", "process_logs", { name: "secretapp" })).toMatchObject({
    success: false,
    errorCode: "DENIED",
  })
})

test("R13-B10: browser_evaluate honours the delegated read-only ceiling", async () => {
  const f = await fixture("local")
  const evaluate = f.registerEvaluate()
  f.db.query("UPDATE bots SET access = 'read-only' WHERE id = 'caller'").run()
  const args = { tabId: "t_01ARZ3NDEKTSV4RRFFQ69G5FAV", expression: "document.forms[0].submit()" }
  expect(await f.call("browser_evaluate", args)).toMatchObject({ success: true })
  f.delegate()
  expect(await f.call("browser_evaluate", args)).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(evaluate.count()).toBe(1)
})
