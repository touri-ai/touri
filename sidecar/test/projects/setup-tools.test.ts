import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Bot, ToolRegistration, UiEvent } from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createStandingGrantStore } from "../../src/approvals/grants"
import { setDelegation } from "../../src/groups/security"
import { createKernel } from "../../src/kernel"
import type { McpCallerContext } from "../../src/mcp/auth"
import { createToolRouter } from "../../src/mcp/router"
import { init as initNotify } from "../../src/notify"
import { inspectGit } from "../../src/projects/git"
import { createProjectStore } from "../../src/projects/repository"
import { createSetupTools } from "../../src/projects/setup-tools"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = async (patch: Partial<Bot> = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-setup-")))
  const home = join(root, "home")
  const path = join(home, "Hodler")
  mkdirSync(join(path, ".git"), { recursive: true })
  const runtime = createKernel({ appData: join(root, "app") })
  const db = runtime.kernel.db as Database
  runtime.kernel.shellEnv = async () => ({ PATH: process.env.PATH ?? "" })
  await initStore(runtime.kernel)
  await initNotify(runtime.kernel)
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "setup-test",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const response = await request("POST", "/bots", {
    name: "setup-bot",
    provider: "codex",
    access: "full",
    approvals: "never",
    ...patch,
    machine: "local",
  })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }
  if (patch.machine === "vm") {
    db.query("UPDATE bots SET machine = 'vm' WHERE id = ?").run(bot.id)
    bot.machine = "vm"
  }
  const cards: ApprovalPart[] = []
  const events: UiEvent[] = []
  runtime.kernel.subscribe(({ event }) => events.push(event))
  const bridge = createApprovalBridge({
    kernel: runtime.kernel,
    timeoutMs: 2000,
    onCard: (_, part) => {
      const index = cards.findIndex((card) => card.approvalId === part.approvalId)
      if (index >= 0) cards[index] = part
      else cards.push(part)
      return true
    },
  })
  runtime.kernel.services.provide("approvals.present", bridge.present)
  runtime.kernel.services.provide("runtime.answerApproval", bridge.approve)
  const store = createProjectStore({ kernel: runtime.kernel })
  const registrations = new Map<string, ToolRegistration>(
    createSetupTools({ kernel: runtime.kernel, store }).map((tool) => [tool.name, tool]),
  )
  const router = createToolRouter({ kernel: runtime.kernel, registrations })
  const caller: McpCallerContext = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    projectId: bot.projectId,
    cwd: bot.homeDir,
    provider: bot.provider,
    browserEnabled: bot.browserEnabled,
    computerUse: bot.computerUse,
  }
  const call = (name: string, args: unknown = {}, context = caller, signal = new AbortController().signal) =>
    router.call({ id: 1, name, args, caller: context, signal })
  const pending = async () => {
    for (let i = 0; i < 200; i++) {
      const part = [...cards].reverse().find((card) => card.decision === "pending")
      if (part) return part
      await Bun.sleep(5)
    }
    throw new Error("No approval card")
  }
  const answer = async (behavior: "allow" | "deny", threadId = caller.threadId) => {
    const part = await pending()
    return request("POST", `/threads/${threadId}/respond`, { requestId: part.approvalId, behavior })
  }
  const currentBot = () => runtime.kernel.services.use("store.api")?.getBot({ botId: bot.id })
  cleanups.push(() => {
    bridge.dispose()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    home,
    path,
    runtime,
    db,
    bot,
    store,
    router,
    caller,
    call,
    cards,
    events,
    pending,
    answer,
    request,
    currentBot,
  }
}

test("discovery lists only projects and repositories in this bot's granted folders without approval", async () => {
  const f = await fixture()
  expect(
    f.router
      .list({ caller: f.caller })
      .map((tool) => tool.name)
      .filter((name) => name !== "capability_request"),
  ).toEqual([
    "bot_rename",
    "project_discover",
    "project_link",
    "folder_access_request",
    "project_unlink",
    "folder_access_remove",
  ])
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [], repositories: [] },
  })
  expect(
    (await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [{ path: f.home, access: "read-only" }] })).status,
  ).toBe(200)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [], repositories: [{ path: f.path, name: "Hodler" }] },
  })
  const project = f.store.createProject({
    id: "project",
    name: "Hodler",
    path: f.path,
    gitRemote: null,
    defaultBranch: null,
    dataDir: join(f.root, "data"),
    now: 1,
  })
  expect(project.success).toBe(true)
  const outside = join(f.root, "outside")
  mkdirSync(join(outside, ".git"), { recursive: true })
  expect(
    f.store.createProject({
      id: "ungranted",
      name: "ungranted",
      path: outside,
      gitRemote: null,
      defaultBranch: null,
      dataDir: join(f.root, "outside-data"),
      now: 1,
    }).success,
  ).toBe(true)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [{ id: "project" }], repositories: [] },
  })
  expect(f.cards).toEqual([])
  expect((await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [], projectId: "project" })).status).toBe(200)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [{ id: "project" }], repositories: [] },
  })
  expect((await f.request("PATCH", `/bots/${f.bot.id}`, { projectId: null, anyFolderAccess: true })).status).toBe(200)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [], repositories: [] },
  })
})

const executableRepository = async (f: Awaited<ReturnType<typeof fixture>>) => {
  mkdirSync(join(f.path, ".git/objects"), { recursive: true })
  mkdirSync(join(f.path, ".git/refs/heads"), { recursive: true })
  mkdirSync(join(f.path, ".git/refs/remotes/origin"), { recursive: true })
  writeFileSync(join(f.path, ".git/HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(f.path, ".git/refs/remotes/origin/HEAD"), "ref: refs/remotes/origin/trunk\n")
  const marker = join(f.root, "fsmonitor-executed")
  const helper = join(f.root, "fsmonitor")
  writeFileSync(helper, `#!/bin/sh\nprintf called > '${marker}'\nprintf 'test-token\\0'\n`)
  chmodSync(helper, 0o700)
  writeFileSync(
    join(f.path, ".git/config"),
    `[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = ${helper}\n[remote "origin"]\nurl = https://example.test/repository.git\n`,
  )
  writeFileSync(join(f.path, "example.txt"), "fixture\n")
  // Positive control: the same repository executes the helper during a status scan.
  await inspectGit({ kernel: f.runtime.kernel, projectPath: f.path })
  expect(existsSync(marker)).toBe(true)
  rmSync(marker)
  return marker
}

test("discovery preserves sensitive subtree exclusions until that folder is explicitly granted", async () => {
  const f = await fixture()
  const protectedPath = join(f.runtime.kernel.paths.appData, "protected-repository")
  mkdirSync(join(protectedPath, ".git"), { recursive: true })
  const registeredPath = join(f.runtime.kernel.paths.appData, "registered-repository")
  mkdirSync(registeredPath)
  expect(
    f.store.createProject({
      id: "protected",
      name: "protected",
      path: registeredPath,
      gitRemote: null,
      defaultBranch: null,
      dataDir: join(f.root, "protected-data"),
      now: 1,
    }).success,
  ).toBe(true)
  expect(
    (await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [{ path: f.root, access: "read-only" }] })).status,
  ).toBe(200)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: { projects: [], repositories: [{ path: f.path }] },
  })
  expect(
    (
      await f.request("PATCH", `/bots/${f.bot.id}`, {
        folders: [
          { path: f.root, access: "read-only" },
          { path: protectedPath, access: "read-only" },
          { path: registeredPath, access: "read-only" },
        ],
      })
    ).status,
  ).toBe(200)
  expect(await f.call("project_discover")).toMatchObject({
    success: true,
    structured: {
      projects: [{ id: "protected" }],
      repositories: expect.arrayContaining([
        expect.objectContaining({ path: f.path }),
        expect.objectContaining({ path: protectedPath }),
      ]),
    },
  })
})

for (const behavior of ["deny", "allow"] as const) {
  test(`project link ${behavior} never runs repository helpers or starts a process before consent`, async () => {
    const f = await fixture({ access: "read-only" })
    const marker = await executableRepository(f)
    let environmentLoads = 0
    let processes = 0
    const shellEnv = f.runtime.kernel.shellEnv
    const spawnTree = f.runtime.kernel.spawnTree
    f.runtime.kernel.shellEnv = async () => {
      environmentLoads++
      return shellEnv()
    }
    f.runtime.kernel.spawnTree = (args) => {
      processes++
      return spawnTree(args)
    }
    const call = f.call("project_link", { path: f.path })
    await f.pending()
    const beforeConsent = { environmentLoads, processes, marker: existsSync(marker) }
    expect((await f.answer(behavior)).status).toBe(200)
    const result = await call
    expect(beforeConsent).toEqual({ environmentLoads: 0, processes: 0, marker: false })
    expect(existsSync(marker)).toBe(false)
    expect(result.success).toBe(behavior === "allow")
    if (behavior === "allow") {
      expect(processes).toBeGreaterThan(0)
      expect(f.store.listProjects()).toMatchObject([
        {
          path: f.path,
          gitRemote: "https://example.test/repository.git",
          defaultBranch: "trunk",
        },
      ])
      expect(f.currentBot()?.projectId).toBe(f.store.listProjects()[0]?.id)
    } else {
      expect(environmentLoads).toBe(0)
      expect(processes).toBe(0)
      expect(f.store.listProjects()).toEqual([])
    }
  })
}

test("canceling a pending project link starts no process and executes no repository helper", async () => {
  const f = await fixture({ access: "read-only" })
  const marker = await executableRepository(f)
  const shellEnv = f.runtime.kernel.shellEnv
  const spawnTree = f.runtime.kernel.spawnTree
  let environmentLoads = 0
  let processes = 0
  f.runtime.kernel.shellEnv = async () => {
    environmentLoads++
    return shellEnv()
  }
  f.runtime.kernel.spawnTree = (args) => {
    processes++
    return spawnTree(args)
  }
  const controller = new AbortController()
  const call = f.call("project_link", { path: f.path }, f.caller, controller.signal)
  await f.pending()
  controller.abort()
  expect(await call).toMatchObject({ success: false, errorCode: "CLIENT_DISCONNECTED" })
  expect(environmentLoads).toBe(0)
  expect(processes).toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(f.store.listProjects()).toEqual([])
  expect(f.currentBot()?.projectId).toBeNull()
})

test("project link revalidates bot settings after post-consent inspection", async () => {
  const f = await fixture()
  const shellEnv = f.runtime.kernel.shellEnv
  f.runtime.kernel.shellEnv = async () => {
    f.db.query("UPDATE bots SET approvals = 'on-request' WHERE id = ?").run(f.bot.id)
    return shellEnv()
  }
  const call = f.call("project_link", { path: f.path })
  expect((await f.answer("allow")).status).toBe(200)
  expect(await call).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(f.store.listProjects()).toEqual([])
  expect(f.currentBot()?.projectId).toBeNull()
})

for (const behavior of ["deny", "allow"] as const) {
  test(`folder ${behavior} defers walking both new and existing grants until consent`, async () => {
    const f = await fixture()
    const existing = join(f.home, "existing")
    mkdirSync(existing)
    expect(
      (await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [{ path: existing, access: "read-only" }] })).status,
    ).toBe(200)
    // Either scan would reject these outward links. Neither may run to present
    // the card or check that a pending approval still targets the same folder.
    symlinkSync(f.root, join(existing, "outside"))
    symlinkSync(f.root, join(f.path, "outside"))
    const call = f.call("folder_access_request", { path: f.path, mode: "read-write" })
    const card = await f.pending()
    expect(card.decision).toBe("pending")
    expect((await f.answer(behavior)).status).toBe(200)
    expect(await call).toMatchObject({
      success: false,
      errorCode: behavior === "deny" ? "DENIED" : "INVALID_ARGS",
    })
    expect(f.currentBot()?.folders).toEqual([{ path: existing, access: "read-only" }])
  })
}

for (const tool of ["project_link", "folder_access_request"]) {
  test(`${tool} preserves the original path for card matching and reviews the canonical target`, async () => {
    const f = await fixture()
    const alias = join(f.home, "alias")
    symlinkSync(f.path, alias)
    const call = f.call(tool, { path: alias, ...(tool === "folder_access_request" ? { mode: "read" } : {}) })
    expect((await f.pending()).detail).toContain(`"requestedPath":"${alias}"`)
    expect((await f.pending()).detail).toContain(`"path":"${f.path}"`)
    expect((await f.answer("allow")).status).toBe(200)
    expect((await call).success).toBe(true)
  })
}

test("project link revalidates the reviewed realpath after post-consent inspection", async () => {
  const f = await fixture()
  const alias = join(f.home, "reviewed")
  symlinkSync(f.path, alias)
  const shellEnv = f.runtime.kernel.shellEnv
  let inspectionStarted = false
  f.runtime.kernel.shellEnv = async () => {
    inspectionStarted = true
    rmSync(alias)
    symlinkSync(f.home, alias)
    return shellEnv()
  }
  const call = f.call("project_link", { path: alias })
  await f.pending()
  const inspectedBeforeConsent = inspectionStarted
  expect((await f.answer("allow")).status).toBe(200)
  expect(await call).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(inspectedBeforeConsent).toBe(false)
  expect(inspectionStarted).toBe(true)
  expect(f.store.listProjects()).toEqual([])
  expect(f.currentBot()?.projectId).toBeNull()
})

for (const access of ["read-only", "workspace-write", "full"] as const) {
  test(`${access} bot with approvals=never must get explicit consent to register and link a project`, async () => {
    const f = await fixture({ access })
    const call = f.call("project_link", { path: f.path })
    const card = await f.pending()
    expect(card).toMatchObject({
      allowStanding: false,
      botId: f.bot.id,
      scope: { source: "mcp", server: "touri", tool: "project_link" },
    })
    expect(card.detail).toContain(f.path)
    expect(f.store.listProjects()).toEqual([])
    expect(f.currentBot()?.projectId).toBeNull()
    expect((await f.answer("allow")).status).toBe(200)
    expect((await call).success).toBe(true)
    const project = f.store.listProjects()[0]
    if (!project) throw new Error("Project was not registered")
    expect(project?.path).toBe(f.path)
    expect(f.currentBot()?.projectId).toBe(project?.id)
    expect(f.events).toContainEqual({ type: "project.created", project })
    expect(f.events.findIndex((event) => event.type === "project.created")).toBeLessThan(
      f.events.findIndex((event) => event.type === "bot.updated"),
    )
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "bot.updated", bot: expect.objectContaining({ projectId: project?.id }) }),
    )
  })
}

test("denying a project link registers nothing and changes no configuration", async () => {
  const f = await fixture()
  const call = f.call("project_link", { path: f.path })
  expect((await f.answer("deny")).status).toBe(200)
  expect(await call).toMatchObject({ success: false, errorCode: "DENIED" })
  expect(f.store.listProjects()).toEqual([])
  expect(f.events.some((event) => event.type === "project.created")).toBe(false)
  expect(f.currentBot()?.projectId).toBeNull()
  expect(f.cards.at(-1)?.decision).toBe("denied")
})

test("projectId and registered paths reuse a project and unlink is visible without approval", async () => {
  const f = await fixture({ approvals: "on-request" })
  const created = f.store.createProject({
    id: "project",
    name: "Hodler",
    path: f.path,
    gitRemote: null,
    defaultBranch: null,
    dataDir: join(f.root, "data"),
    now: 1,
  })
  expect(created.success).toBe(true)
  for (const args of [{ projectId: "project" }, { path: f.path }]) {
    const call = f.call("project_link", args)
    expect((await f.answer("allow")).status).toBe(200)
    expect((await call).success).toBe(true)
  }
  expect(f.store.listProjects()).toHaveLength(1)
  const cardCount = f.cards.length
  expect((await f.call("project_unlink")).success).toBe(true)
  expect(f.currentBot()?.projectId).toBeNull()
  expect(f.cards).toHaveLength(cardCount)
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "message.created",
      message: expect.objectContaining({
        kind: "notice",
        text: "Projeto Hodler desvinculado deste bot. A configuração foi salva neste Mac. Vale a partir da próxima mensagem.",
      }),
    }),
  )
})

for (const [mode, access] of [
  ["read", "read-only"],
  ["read-write", "read-write"],
] as const) {
  test(`folder ${mode} approval applies only the reviewed folder and mode; removal needs no approval`, async () => {
    const f = await fixture({ approvals: "on-request" })
    const call = f.call("folder_access_request", { path: f.path, mode })
    expect((await f.pending()).detail).toContain(`"mode":"${mode}"`)
    expect(f.currentBot()?.folders).toEqual([])
    expect((await f.answer("allow")).status).toBe(200)
    expect((await call).success).toBe(true)
    expect(f.currentBot()?.folders).toEqual([{ path: f.path, access }])
    expect(f.currentBot()?.anyFolderAccess).toBe(false)
    const cardCount = f.cards.length
    rmSync(f.path, { recursive: true })
    expect((await f.call("folder_access_remove", { path: f.path })).success).toBe(true)
    expect(f.currentBot()?.folders).toEqual([])
    expect(f.cards).toHaveLength(cardCount)
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "message.created",
        message: expect.objectContaining({
          text: `Acesso à pasta ${f.path} removido deste bot. A configuração foi salva neste Mac. Vale a partir da próxima mensagem.`,
        }),
      }),
    )
  })
}

test("denial and cancellation leave folders unchanged, even with standing grants", async () => {
  const f = await fixture()
  createStandingGrantStore(f.runtime.kernel).add(f.bot.id, {
    source: "mcp",
    server: "touri",
    tool: "folder_access_request",
  })
  const denied = f.call("folder_access_request", { path: f.path, mode: "read-write" })
  expect((await f.answer("deny")).status).toBe(200)
  expect((await denied).success).toBe(false)
  const controller = new AbortController()
  const canceled = f.call("folder_access_request", { path: f.path, mode: "read" }, f.caller, controller.signal)
  await f.pending()
  controller.abort()
  expect((await canceled).success).toBe(false)
  expect(f.currentBot()?.folders).toEqual([])
})

for (const missing of [false, true]) {
  test(`write access ${missing ? "creates a missing subfolder" : "recovers an existing folder"} under a read-only root`, async () => {
    const f = await fixture()
    const folders: Bot["folders"] = [{ path: f.home, access: "read-only" }]
    expect((await f.request("PATCH", `/bots/${f.bot.id}`, { folders })).status).toBe(200)
    const target = missing ? join(f.path, "images", "generated") : f.path
    const call = f.call("folder_access_request", { path: target, mode: "read-write" })
    const card = await f.pending()
    expect(card.detail).toContain(`"path":"${f.home}"`)
    expect(card.detail).toContain('"previousMode":"read-only"')
    if (missing) {
      expect(card.detail).toContain(`"createPath":"${target}"`)
      expect(existsSync(target)).toBe(false)
    }
    expect(f.currentBot()?.folders).toEqual(folders)
    expect((await f.answer("allow")).status).toBe(200)
    expect(await call).toMatchObject({ success: true, structured: { effective: "next-turn" } })
    expect(existsSync(target)).toBe(true)
    expect(f.currentBot()?.folders).toEqual([{ path: f.home, access: "read-write" }])
    expect(f.cards).toHaveLength(1)
    writeFileSync(join(target, "image.png"), "image fixture")
  })
}

test("denying a missing folder leaves the tree and read-only grant unchanged", async () => {
  const f = await fixture()
  const folders: Bot["folders"] = [{ path: f.home, access: "read-only" }]
  expect((await f.request("PATCH", `/bots/${f.bot.id}`, { folders })).status).toBe(200)
  const target = join(f.path, "images")
  const call = f.call("folder_access_request", { path: target, mode: "read-write" })
  expect((await f.answer("deny")).status).toBe(200)
  expect(await call).toMatchObject({
    success: false,
    errorCode: "DENIED",
    error: expect.stringContaining("Nenhuma pasta foi criada"),
  })
  expect(existsSync(target)).toBe(false)
  expect(f.currentBot()?.folders).toEqual(folders)
})

test("missing folders outside allowed roots and through escape links are refused without approval", async () => {
  const f = await fixture()
  expect(
    (await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [{ path: f.path, access: "read-only" }] })).status,
  ).toBe(200)
  symlinkSync(f.root, join(f.path, "escape"))
  for (const path of [join(f.home, "outside", "images"), join(f.path, "escape", "images")]) {
    expect(await f.call("folder_access_request", { path, mode: "read-write" })).toMatchObject({
      success: false,
      errorCode: "DENIED",
    })
    expect(existsSync(path)).toBe(false)
  }
  expect(f.cards).toEqual([])
})

test("a missing path retargeted while awaiting approval is not created or granted", async () => {
  const f = await fixture()
  const folders: Bot["folders"] = [{ path: f.home, access: "read-only" }]
  expect((await f.request("PATCH", `/bots/${f.bot.id}`, { folders })).status).toBe(200)
  const target = join(f.path, "images", "generated")
  const call = f.call("folder_access_request", { path: target, mode: "read-write" })
  await f.pending()
  symlinkSync(f.root, join(f.path, "images"))
  expect((await f.answer("allow")).status).toBe(410)
  expect((await call).success).toBe(false)
  expect(existsSync(join(f.root, "generated"))).toBe(false)
  expect(f.currentBot()?.folders).toEqual(folders)
})

test("missing folders under writable grants are created with one approval on the nearest existing ancestor", async () => {
  const f = await fixture()
  expect(
    (await f.request("PATCH", `/bots/${f.bot.id}`, { folders: [{ path: f.home, access: "read-write" }] })).status,
  ).toBe(200)
  const target = join(f.path, "images", "generated")
  const call = f.call("folder_access_request", { path: target, mode: "read-write" })
  expect((await f.pending()).detail).toContain(`"path":"${f.path}"`)
  expect((await f.answer("allow")).status).toBe(200)
  expect((await call).success).toBe(true)
  expect(existsSync(target)).toBe(true)
  expect(f.cards).toHaveLength(1)
})

test("global read-only mode and protected subtrees cannot be bypassed by creating a folder", async () => {
  const f = await fixture({ access: "read-only", anyFolderAccess: true })
  for (const path of [join(f.bot.homeDir, "images"), join(f.runtime.kernel.paths.appData, "protected", "images")]) {
    expect(await f.call("folder_access_request", { path, mode: "read-write" })).toMatchObject({
      success: false,
      errorCode: "DENIED",
    })
    expect(existsSync(path)).toBe(false)
  }
  expect(f.cards).toEqual([])
})

test("schema forbids other bot IDs, any-folder access, invalid modes and ambiguous project targets", async () => {
  const f = await fixture()
  for (const [name, args] of [
    ["project_link", { path: f.path, botId: "other" }],
    ["project_link", { path: f.path, projectId: "other" }],
    ["project_link", {}],
    ["project_unlink", { botId: "other" }],
    ["folder_access_request", { path: f.path, mode: "read", botId: "other" }],
    ["folder_access_request", { path: f.path, mode: "read", anyFolderAccess: true }],
    ["folder_access_request", { anyFolderAccess: true }],
    ["folder_access_request", { path: f.path, mode: "full" }],
    ["folder_access_remove", { path: f.path, botId: "other" }],
  ] as const)
    expect(await f.call(name, args)).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
  for (const path of ["/", "/*", "relative"])
    expect((await f.call("folder_access_request", { path, mode: "read-write" })).success).toBe(false)
  expect((await f.call("project_link", { path: "/" })).success).toBe(false)
  expect(f.cards).toEqual([])
  expect(f.currentBot()?.anyFolderAccess).toBe(false)
})

test("a foreign thread and delegated peer cannot change this bot", async () => {
  const f = await fixture()
  const other = (await (await f.request("POST", "/bots", { name: "other", provider: "codex" })).json()).bot as Bot
  const spoofed = { ...f.caller, botId: other.id }
  expect((await f.call("project_link", { path: f.path }, spoofed)).success).toBe(false)
  setDelegation(f.runtime.kernel, f.caller.threadId, {
    ceiling: f.bot,
    caller: { id: other.id, name: other.name },
    groupThreadId: "group",
    secrets: false,
  })
  for (const [name, args] of [
    ["project_discover", {}],
    ["project_link", { path: f.path }],
    ["project_unlink", {}],
    ["folder_access_request", { path: f.path, mode: "read" }],
    ["folder_access_remove", { path: f.path }],
  ] as const)
    expect((await f.call(name, args)).success).toBe(false)
  expect(f.cards).toEqual([])
  expect(f.currentBot()?.projectId).toBeNull()
  expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: other.id })?.projectId).toBeNull()
})

test("configuration edits or filesystem retargeting while a card is pending invalidate approval", async () => {
  const f = await fixture()
  const call = f.call("folder_access_request", { path: f.path, mode: "read-write" })
  await f.pending()
  expect((await f.request("PATCH", `/bots/${f.bot.id}`, { approvals: "on-request" })).status).toBe(200)
  expect((await f.answer("allow")).status).toBe(410)
  expect((await call).success).toBe(false)
  const alias = join(f.home, "alias")
  symlinkSync(f.path, alias)
  const link = f.call("project_link", { path: alias })
  await f.pending()
  rmSync(alias)
  symlinkSync(f.home, alias)
  expect((await f.answer("allow")).status).toBe(410)
  expect((await link).success).toBe(false)
  expect(f.store.listProjects()).toEqual([])
  expect(f.currentBot()?.folders).toEqual([])
})

test("local setup reports the host and next message for project and folder changes", async () => {
  const f = await fixture()
  for (const [name, args] of [
    ["project_link", { path: f.path }],
    ["folder_access_request", { path: f.path, mode: "read-write" }],
  ] as const) {
    const call = f.call(name, args)
    expect((await f.pending()).detail).toContain('"nextTurn":true')
    expect((await f.pending()).detail).toContain('"machine":"local"')
    expect((await f.answer("allow")).status).toBe(200)
    const result = await call
    expect(result).toMatchObject({
      success: true,
      structured: { effective: "next-turn" },
      content: [{ type: "text", text: expect.stringContaining("próxima mensagem") }],
    })
    if (!result.success) throw new Error(result.error)
    expect(result.structured).toHaveProperty("message", expect.not.stringContaining("VM"))
    expect(JSON.stringify(result)).toContain("neste Mac")
  }
  for (const [name, args] of [
    ["project_unlink", {}],
    ["folder_access_remove", { path: f.path }],
  ] as const) {
    const result = await f.call(name, args)
    expect(result.success).toBe(true)
    expect(JSON.stringify(result)).toContain("próxima mensagem")
    if (!result.success) throw new Error(result.error)
    expect(result.structured).toHaveProperty("message", expect.not.stringContaining("VM"))
  }
})

test("VM setup takes effect from the next message without invoking any VM runtime", async () => {
  const f = await fixture({ machine: "vm" })
  for (const [name, args] of [
    ["project_link", { path: f.path }],
    ["folder_access_request", { path: f.path, mode: "read-write" }],
  ] as const) {
    const call = f.call(name, args)
    expect((await f.pending()).detail).toContain('"nextTurn":true')
    expect((await f.answer("allow")).status).toBe(200)
    expect(await call).toMatchObject({
      success: true,
      structured: { effective: "next-turn" },
      content: [{ type: "text", text: expect.stringContaining("próxima mensagem na VM") }],
    })
  }
  expect(f.currentBot()?.folders).toEqual([{ path: f.path, access: "read-write" }])
})

test("simultaneous approvals cannot overwrite a configuration changed by another tool call", async () => {
  const f = await fixture()
  const first = f.call("folder_access_request", { path: f.path, mode: "read" })
  const second = f.call("folder_access_request", { path: f.path, mode: "read-write" })
  await f.pending()
  expect(f.cards).toHaveLength(2)
  await Promise.all(
    f.cards.map((card) =>
      f.request("POST", `/threads/${f.caller.threadId}/respond`, { requestId: card.approvalId, behavior: "allow" }),
    ),
  )
  const results = await Promise.all([first, second])
  expect(results.filter((result) => result.success)).toHaveLength(1)
  expect(results.filter((result) => !result.success)).toHaveLength(1)
  expect(f.currentBot()?.folders).toHaveLength(1)
})

test("removing a grant keeps the user-only any-folder toggle and unrelated grants intact", async () => {
  const f = await fixture({ anyFolderAccess: true })
  const extra = join(f.home, "extra")
  mkdirSync(extra)
  expect(
    (
      await f.request("PATCH", `/bots/${f.bot.id}`, {
        folders: [
          { path: extra, access: "read-only" },
          { path: f.path, access: "read-write" },
        ],
      })
    ).status,
  ).toBe(200)
  expect((await f.call("folder_access_remove", { path: f.path })).success).toBe(true)
  expect(f.currentBot()?.folders).toEqual([{ path: extra, access: "read-only" }])
  expect(f.currentBot()?.anyFolderAccess).toBe(true)
  expect(f.cards).toEqual([])
})

for (const machine of ["local", "vm"] as const)
  test(`bot_rename on ${machine} renames only the caller, publishes the new name and posts a notice without approval`, async () => {
    const f = await fixture({ machine, access: "read-only", approvals: "on-request" })
    const before = f.currentBot()
    if (!before) throw new Error("Missing bot")
    expect(await f.call("bot_rename", { name: " Bia QA Renomeada " })).toMatchObject({
      success: true,
      structured: { name: "Bia QA Renomeada" },
    })
    expect(f.currentBot()).toEqual({ ...before, name: "Bia QA Renomeada", updatedAt: expect.any(Number) })
    expect(f.cards).toEqual([])
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "bot.updated",
        bot: expect.objectContaining({ id: f.bot.id, name: "Bia QA Renomeada" }),
      }),
    )
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "message.created",
        message: expect.objectContaining({
          threadId: f.caller.threadId,
          role: "system",
          kind: "notice",
          text: expect.stringContaining("Bia QA Renomeada"),
        }),
      }),
    )
    expect(f.runtime.kernel.services.use("store.api")?.activePath({ threadId: f.caller.threadId }).at(-1)?.kind).toBe(
      "notice",
    )
  })

test("bot_rename validates names like creation and settings; cannot target another bot", async () => {
  const f = await fixture()
  for (const name of [null, 123, "", "   ", "a".repeat(81), "Bia\nQA", "Bia\tQA", "Bia\0QA", "Bia\u2028QA"]) {
    expect(await f.call("bot_rename", { name })).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
    expect((await f.request("POST", "/bots", { name, provider: "codex" })).status).toBe(400)
    expect((await f.request("PATCH", `/bots/${f.bot.id}`, { name })).status).toBe(400)
  }
  expect(await f.call("bot_rename", { name: "Other", botId: "other" })).toMatchObject({
    success: false,
    errorCode: "INVALID_ARGS",
  })
  expect(await f.call("bot_rename", { name: 123 })).toMatchObject({ success: false, errorCode: "INVALID_ARGS" })
  expect((await f.call("bot_rename", { name: "Bia • São Paulo 🤖" })).success).toBe(true)
  expect((await f.call("bot_rename", { name: ` ${"a".repeat(80)} ` })).success).toBe(true)
  expect(f.currentBot()?.name).toBe("a".repeat(80))
  expect(f.cards).toEqual([])
})

test("bot_rename denies foreign threads, delegated requests and cancellation", async () => {
  const f = await fixture()
  const other = (await (await f.request("POST", "/bots", { name: "other", provider: "codex" })).json()).bot as Bot
  expect((await f.call("bot_rename", { name: "Changed" }, { ...f.caller, botId: other.id })).success).toBe(false)
  const controller = new AbortController()
  controller.abort()
  expect((await f.call("bot_rename", { name: "Changed" }, f.caller, controller.signal)).success).toBe(false)
  setDelegation(f.runtime.kernel, f.caller.threadId, {
    ceiling: f.bot,
    caller: { id: other.id, name: other.name },
    groupThreadId: "group",
    secrets: false,
  })
  expect((await f.call("bot_rename", { name: "Changed" })).success).toBe(false)
  expect(f.currentBot()?.name).toBe(f.bot.name)
  expect(f.runtime.kernel.services.use("store.api")?.getBot({ botId: other.id })?.name).toBe("other")
  expect(f.cards).toEqual([])
})
