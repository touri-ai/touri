import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Message, ProviderAdapter, StartTurnArgs, ToolRegistration } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import * as folderCapability from "../../src/kernel/folder-capability"
import { createToolRouter } from "../../src/mcp/router"
import { createProjectStore } from "../../src/projects/repository"
import { createSetupTools } from "../../src/projects/setup-tools"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { writableTurnFolders } from "../../src/runtime/folder-access"
import { init as initStore } from "../../src/store"

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the permission continuation")
    await Bun.sleep(5)
  }
}

const requestText = "Crie um arquivo notas.md com a palavra teste e me mostre o conteúdo."

const fixture = async ({ missingOutput = false, browserTask = false } = {}) => {
  const taskText = browserTask ? "Abra https://example.test/reference; pode ativar seu navegador." : requestText
  // Canonical: macOS tmpdir lives behind /var -> /private/var, and grants refuse moved folders.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-permission-continuation-")))
  const reference = join(root, "reference")
  const folder = missingOutput ? join(reference, "images", "generated") : join(root, "notes")
  if (!missingOutput) mkdirSync(folder)
  mkdirSync(reference)
  // Exercise the real store and approval bridge without opening a network listener.
  const serve = spyOn(Bun, "serve").mockReturnValue({
    port: 0,
    stop: () => {},
  } as unknown as ReturnType<typeof Bun.serve>)
  let runtime: ReturnType<typeof createKernel>
  try {
    runtime = createKernel({ appData: join(root, "app") })
  } finally {
    serve.mockRestore()
  }
  await initStore(runtime.kernel)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO bots(id,name,provider,home_dir,folders_json,created_at,updated_at) VALUES (?,?,?,?,?,1,1)").run(
    "b",
    "Teste",
    "codex",
    join(root, "workspace"),
    JSON.stringify([{ path: reference, access: "read-only" }]),
  )
  db.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1)")
  if (browserTask) db.exec("UPDATE bots SET browser_enabled=0 WHERE id='b'")
  const opened: string[] = []
  let router: ReturnType<typeof createToolRouter>
  const turns: StartTurnArgs[] = []
  const releases: Array<() => void> = []
  const adapter: ProviderAdapter = {
    provider: "codex",
    detect: async () => ({ success: true, path: "/tmp/fake-provider", version: "1", loggedIn: true }),
    startTurn: async (args) => {
      const index = turns.push(args) - 1
      args.onEvent({ type: "session", externalSessionId: `session-${index}`, rolloutPath: null })
      args.onEvent({ type: "turn_started", externalTurnId: `turn-${index}` })
      await new Promise<void>((resolve) => {
        releases[index] = resolve
        args.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      if (browserTask && args.bot.browserEnabled && !args.signal.aborted) {
        const result = await router.call({
          id: 1,
          name: "browser_open",
          args: { url: "https://example.test/reference" },
          caller: {
            botId: "b",
            threadId: "t",
            projectId: null,
            cwd: args.bot.homeDir,
            provider: "codex",
            browserEnabled: args.bot.browserEnabled,
            computerUse: args.bot.computerUse,
          },
          signal: args.signal,
        })
        expect(result.success).toBe(true)
      }
      const canWrite = writableTurnFolders(args).includes(missingOutput ? reference : folder)
      if (canWrite && !args.signal.aborted) writeFileSync(join(folder, "notas.md"), "teste")
      args.onEvent({
        type: "text_delta",
        itemId: "reply",
        delta: browserTask && args.bot.browserEnabled ? "Página aberta." : canWrite ? "teste" : "Acesso pendente.",
      })
      return { success: true, externalSessionId: `session-${index}`, rolloutPath: null, status: "succeeded" }
    },
    answerApproval: async () => ({ success: true }),
    shutdown: async () => {},
  }
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    providerAdapters: { codex: adapter },
    environment: { PATH: "/usr/bin" },
  })
  runtime.kernel.services.provide("runtime.activeRun", engine.activeRun)
  runtime.kernel.services.provide("approvals.present", engine.approvalBridge.present)
  runtime.kernel.services.provide("runtime.continueAfterApproval", engine.continueAfterApproval)
  const projects = createProjectStore({ kernel: runtime.kernel })
  runtime.kernel.services.provide("projects.info", async ({ projectId }) => {
    const project = projects.getProject(projectId)
    return project ? { project, git: null, hints: [], processes: [], previews: [], secretNames: [] } : null
  })
  const tools = createSetupTools({ kernel: runtime.kernel, store: projects })
  const registrations = new Map<string, ToolRegistration>(tools.map((tool) => [tool.name, tool]))
  registrations.set("browser_open", {
    name: "browser_open",
    group: "browser",
    handler: async ({ args }) => {
      opened.push((args as { url: string }).url)
      return { success: true, content: [] }
    },
  })
  router = createToolRouter({ kernel: runtime.kernel, registrations })
  runtime.kernel.services.provide("mcp.botTools", (bot) =>
    router
      .list({
        caller: {
          botId: bot.id,
          threadId: "t",
          projectId: null,
          cwd: bot.homeDir,
          provider: bot.provider,
          browserEnabled: bot.browserEnabled,
          computerUse: bot.computerUse,
        },
      })
      .map((tool) => tool.name),
  )
  const send = (
    text = taskText,
    sender: Message["sender"] = { id: "requester", name: "Requester", kind: "person" },
  ) => {
    const message = store.insertMessage({
      message: {
        id: runtime.kernel.newId(),
        threadId: "t",
        parentId: store.getThread({ threadId: "t" })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text,
        parts: [{ type: "text", text }],
        sender,
        source: "local",
      },
    })
    if (!message.success) throw new Error(message.error)
    return engine.enqueue({ threadId: "t", requestMessageId: message.message.id, trigger: "user" })
  }
  const call = (name = "folder_access_request", args: unknown = { path: folder, mode: "read-write" }) => {
    const tool = tools.find((tool) => tool.name === name)
    const turn = turns.at(-1)
    if (!tool || !turn) throw new Error("Missing tool or turn")
    return tool.handler({
      ctx: {
        botId: "b",
        threadId: "t",
        runId: engine.activeRun({ threadId: "t" })?.id ?? null,
        projectId: turn.bot.projectId,
        cwd: turn.fingerprint.cwd,
        signal: turn.signal,
      },
      args,
    })
  }
  const cards = () =>
    store
      .activePath({ threadId: "t" })
      .flatMap((message) => message.parts.filter((part): part is ApprovalPart => part.type === "approval"))
  const answer = async (decision: "approved" | "denied" = "approved") => {
    await waitFor(() => cards().some((part) => part.decision === "pending"))
    const card = cards().find((part) => part.decision === "pending")
    if (!card) throw new Error("Missing approval")
    expect(await engine.answerApproval({ approvalId: card.approvalId, decision })).toMatchObject({ success: true })
    return card.approvalId
  }
  const finish = async (index: number) => {
    const runId = engine.activeRun({ threadId: "t" })?.id
    releases[index]?.()
    await waitFor(() => engine.listRuns("t", { all: true }).find((run) => run.id === runId)?.status === "succeeded")
    await Bun.sleep(30)
  }
  const close = async () => {
    await engine.shutdown()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
  const initialRun = send()
  await waitFor(() => turns.length === 1)
  return { folder, reference, turns, db, store, engine, call, cards, answer, finish, close, send, opened, initialRun }
}

test("only the requester or bot owner can return a browser takeover from a channel", async () => {
  const f = await fixture()
  try {
    if (!f.initialRun.success) throw new Error("Could not start the requester turn")
    f.db
      .query(
        "INSERT INTO bot_groups (id, name, color, avatar_shape, avatar_seed, created_at, updated_at) VALUES ('group-1', 'Grupo', '#2563eb', 'classic-none', 'seed', 1, 1)",
      )
      .run()
    f.db
      .query("INSERT INTO group_turns (run_id, group_id, recipients_json) VALUES (?, 'group-1', ?)")
      .run(f.initialRun.run.id, JSON.stringify(["b"]))
    const marker = f.store.insertMessage({
      message: {
        id: "channel-member-request",
        threadId: "t",
        parentId: f.initialRun.run.requestMessageId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: null,
        text: "Pedido do canal",
        parts: [{ type: "notice", level: "info", code: "group_coordination_prompt", text: "Pedido do canal" }],
        sender: null,
        source: "local",
      },
    })
    if (!marker.success) throw new Error(marker.error)
    const channelRun = f.engine.enqueue({ threadId: "t", requestMessageId: marker.message.id, trigger: "retry" })
    if (!channelRun.success) throw new Error("Could not create the channel member run")
    f.db
      .query("INSERT INTO group_run_links (run_id, turn_id, depth) VALUES (?, ?, 0)")
      .run(channelRun.run.id, f.initialRun.run.id)

    expect(
      f.engine.canReturnBrowserTakeover({
        botId: "b",
        threadId: "t",
        runId: channelRun.run.id,
        personId: "requester",
      }),
    ).toBe(true)
    expect(
      f.engine.canReturnBrowserTakeover({
        botId: "b",
        threadId: "t",
        runId: channelRun.run.id,
        personId: "channel-member",
      }),
    ).toBe(false)
    expect(
      f.engine.canReturnBrowserTakeover({
        botId: "b",
        threadId: "t",
        runId: channelRun.run.id,
        personId: "owner",
      }),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test("a browser handback continues an active run exactly once with resume disabled", async () => {
  const f = await fixture()
  try {
    if (!f.initialRun.success) throw new Error("Could not start the requester turn")
    f.db.exec("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1)")
    const runId = f.initialRun.run.id
    const handback = { botId: "b", threadId: "t", runId }

    expect(f.engine.resumeAfterBrowserTakeover(handback)).toBe(true)
    expect(f.engine.resumeAfterBrowserTakeover(handback)).toBe(true)
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]?.input).toContainEqual({
      type: "text",
      text: expect.stringContaining(requestText),
    })
    expect(f.db.query("SELECT previous_run_id FROM browser_takeover_continuations").all()).toEqual([
      { previous_run_id: runId },
    ])
    await f.finish(1)
    expect(f.turns).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("a repeated browser handback does not duplicate a completed run continuation", async () => {
  const f = await fixture()
  try {
    if (!f.initialRun.success) throw new Error("Could not start the requester turn")
    await f.finish(0)
    const handback = { botId: "b", threadId: "t", runId: f.initialRun.run.id }

    expect(f.engine.resumeAfterBrowserTakeover(handback)).toBe(true)
    expect(f.engine.resumeAfterBrowserTakeover(handback)).toBe(true)
    await waitFor(() => f.turns.length === 2)

    expect(f.db.query("SELECT previous_run_id FROM browser_takeover_continuations").all()).toEqual([
      { previous_run_id: f.initialRun.run.id },
    ])
    await f.finish(1)
    expect(f.turns).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("saved incompatible grants allow later greetings in conversation-only mode without losing stored permissions", async () => {
  const f = await fixture()
  const unavailable = spyOn(folderCapability, "hostFolderAccessAvailable").mockReturnValue(false)
  try {
    await f.finish(0)
    f.send("oi")
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]).toMatchObject({
      conversationOnly: true,
      bot: { folders: [], anyFolderAccess: false, access: "read-only", projectId: null },
    })
    expect(f.turns[1]?.input).toContainEqual({ type: "text", text: expect.stringContaining("oi") })
    expect(f.store.getBot({ botId: "b" })?.folders).toEqual([{ path: f.reference, access: "read-only" }])
    const result = await f.call()
    expect(result).toMatchObject({ success: false })
    expect(f.cards()).toHaveLength(0)
    await f.finish(1)
    expect(
      f.store
        .activePath({ threadId: "t" })
        .some((message) =>
          message.parts.some((part) => part.type === "notice" && part.code === "folder_access_unavailable"),
        ),
    ).toBe(true)
    f.send("oi de novo")
    await waitFor(() => f.turns.length === 3)
    expect(f.turns[2]?.conversationOnly).toBe(true)
    await f.finish(2)
  } finally {
    unavailable.mockRestore()
    await f.close()
  }
})

test("a grant-free bot without confinement keeps its tools and gets no folder warning", async () => {
  const f = await fixture()
  f.db.query("UPDATE bots SET folders_json = '[]' WHERE id = 'b'").run()
  const unavailable = spyOn(folderCapability, "hostFolderAccessAvailable").mockReturnValue(false)
  try {
    await f.finish(0)
    f.send("Liste as notas")
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]?.conversationOnly).toBeUndefined()
    expect(f.turns[1]?.bot.folders).toEqual([])
    await f.finish(1)
    expect(
      f.store
        .activePath({ threadId: "t" })
        .some((message) =>
          message.parts.some((part) => part.type === "notice" && part.code === "folder_access_unavailable"),
        ),
    ).toBe(false)
  } finally {
    unavailable.mockRestore()
    await f.close()
  }
})

test("a full-access bot with saved grants is never degraded by an incompatible host", async () => {
  const f = await fixture()
  f.db.query("UPDATE bots SET access = 'full', any_folder_access = 1 WHERE id = 'b'").run()
  const unavailable = spyOn(folderCapability, "hostFolderAccessAvailable").mockReturnValue(false)
  try {
    await f.finish(0)
    f.send("Liste as notas")
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]?.conversationOnly).toBeUndefined()
    expect(f.turns[1]?.bot).toMatchObject({ access: "full", folders: [{ path: f.reference, access: "read-only" }] })
    await f.finish(1)
    expect(f.store.getBot({ botId: "b" })?.folders).toEqual([{ path: f.reference, access: "read-only" }])
  } finally {
    unavailable.mockRestore()
    await f.close()
  }
})

test("saved system filesystem grants recover as conversation-only without changing stored permissions", async () => {
  if (process.platform !== "linux") return
  const f = await fixture()
  try {
    await f.finish(0)
    const folders = [{ path: "/proc", access: "read-only" as const }]
    f.db.query("UPDATE bots SET folders_json = ? WHERE id = 'b'").run(JSON.stringify(folders))
    f.send("oi")
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]).toMatchObject({ conversationOnly: true, bot: { folders: [] } })
    expect(f.turns[1]?.input).toContainEqual({ type: "text", text: expect.stringContaining("oi") })
    expect(f.store.getBot({ botId: "b" })?.folders).toEqual(folders)
    await f.finish(1)
  } finally {
    await f.close()
  }
})

test("a reopened bot with saved grants can start its first conversation on an incompatible host", async () => {
  const unavailable = spyOn(folderCapability, "hostFolderAccessAvailable").mockReturnValue(false)
  const f = await fixture()
  try {
    expect(f.turns[0]?.conversationOnly).toBe(true)
    await f.finish(0)
    f.send("oi")
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]?.conversationOnly).toBe(true)
    await f.finish(1)
    expect(f.store.getBot({ botId: "b" })?.folders).toHaveLength(1)
  } finally {
    unavailable.mockRestore()
    await f.close()
  }
})

test("approved missing output folders are created before exactly one permission continuation", async () => {
  const f = await fixture({ missingOutput: true })
  try {
    f.db.exec("INSERT INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1)")
    const approval = f.call()
    expect(existsSync(f.folder)).toBe(false)
    const id = await f.answer()
    expect(await approval).toMatchObject({ success: true, structured: { automaticContinuation: true } })
    expect(existsSync(f.folder)).toBe(true)
    expect(f.cards()).toHaveLength(1)
    expect(f.cards()[0]?.detail).toContain(`"path":"${f.reference}"`)
    expect(f.cards()[0]?.detail).toContain(`"createPath":"${f.folder}"`)
    expect(f.turns).toHaveLength(1)
    expect(writableTurnFolders(f.turns[0] as StartTurnArgs)).toEqual([])
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    expect(writableTurnFolders(f.turns[1] as StartTurnArgs)).toEqual([f.reference])
    expect(f.turns[1]?.input).toContainEqual({ type: "text", text: expect.stringContaining(requestText) })
    expect(await f.engine.answerApproval({ approvalId: id, decision: "approved" })).toMatchObject({ success: false })
    await f.finish(1)
    expect(readFileSync(join(f.folder, "notas.md"), "utf8")).toBe("teste")
    expect(f.turns).toHaveLength(2)
    expect(f.db.query("SELECT reason FROM run_continuations").all()).toEqual([{ reason: "permission_granted" }])
  } finally {
    await f.close()
  }
})

test("denied missing output folders are neither created nor continued", async () => {
  const f = await fixture({ missingOutput: true })
  try {
    const approval = f.call()
    await f.answer("denied")
    expect((await approval).success).toBe(false)
    await f.finish(0)
    expect(existsSync(f.folder)).toBe(false)
    expect(f.cards()).toHaveLength(1)
    expect(f.turns).toHaveLength(1)
    expect(f.db.query("SELECT * FROM run_continuations").all()).toEqual([])
    expect(f.store.getBot({ botId: "b" })?.folders).toEqual([{ path: f.reference, access: "read-only" }])
  } finally {
    await f.close()
  }
})

test("approved folder access continues once on the same thread with the original request and exact new scope", async () => {
  const f = await fixture()
  try {
    const approval = f.call()
    const id = await f.answer()
    expect(await approval).toMatchObject({ success: true, structured: { automaticContinuation: true } })
    expect(f.turns).toHaveLength(1)
    expect(writableTurnFolders(f.turns[0] as StartTurnArgs)).toEqual([])
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    const next = f.turns[1]
    expect(next).toBeDefined()
    expect(next?.bot.folders).toEqual([
      { path: f.reference, access: "read-only" },
      { path: f.folder, access: "read-write" },
    ])
    expect(next?.bot.anyFolderAccess).toBe(false)
    expect(next?.bot.access).toBe("workspace-write")
    expect(next?.session).toBeNull()
    expect(next?.thread.id).toBe("t")
    expect(next?.input).toContainEqual({ type: "text", text: expect.stringContaining(requestText) })
    expect(next?.handoffPacket).toContain(requestText)
    expect(await f.engine.answerApproval({ approvalId: id, decision: "approved" })).toMatchObject({ success: false })
    await f.finish(1)
    expect(readFileSync(join(f.folder, "notas.md"), "utf8")).toBe("teste")
    const path = f.store.activePath({ threadId: "t" })
    expect(path.filter((message) => message.role === "user")).toHaveLength(1)
    expect(
      path.filter((message) => message.parts.some((part) => part.type === "notice" && part.code === "run_resumed")),
    ).toEqual([expect.objectContaining({ role: "system", text: "Retomado após aprovação de acesso" })])
    expect(path.at(-1)?.text).toBe("teste")
    expect(f.db.query("SELECT reason FROM run_continuations").all()).toEqual([{ reason: "permission_granted" }])
    expect(f.turns).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("denied folder access does not continue or widen permissions", async () => {
  const f = await fixture()
  try {
    const approval = f.call()
    await f.answer("denied")
    expect((await approval).success).toBe(false)
    await f.finish(0)
    expect(f.turns).toHaveLength(1)
    expect(f.db.query("SELECT * FROM run_continuations").all()).toEqual([])
    expect(f.store.getBot({ botId: "b" })?.folders).toEqual([{ path: f.reference, access: "read-only" }])
  } finally {
    await f.close()
  }
})

test("an existing grant in the continuation needs no approval and cannot loop", async () => {
  const f = await fixture()
  try {
    const first = f.call()
    await f.answer()
    await first
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    const cards = f.cards().length
    expect(await f.call()).toMatchObject({
      success: true,
      structured: { unchanged: true, automaticContinuation: false, effective: "current-turn" },
    })
    expect(f.cards()).toHaveLength(cards)
    expect(f.cards().some((part) => part.decision === "pending")).toBe(false)
    await f.finish(1)
    expect(f.turns).toHaveLength(2)
    expect(f.engine.listRuns("t", { all: true })).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("multiple approved changes in a turn produce one continuation", async () => {
  const f = await fixture()
  try {
    for (const mode of ["read", "read-write"]) {
      const approval = f.call("folder_access_request", { path: f.folder, mode })
      await f.answer()
      expect((await approval).success).toBe(true)
    }
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    expect(writableTurnFolders(f.turns[1] as StartTurnArgs)).toEqual([f.folder])
    await f.finish(1)
    expect(f.turns).toHaveLength(2)
    expect(f.db.query("SELECT * FROM run_continuations").all()).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("approved project setup also continues when interrupted-turn recovery is disabled", async () => {
  const f = await fixture()
  try {
    f.db.exec("INSERT INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1)")
    const approval = f.call("project_link", { path: f.folder })
    await f.answer()
    expect(await approval).toMatchObject({ success: true, structured: { automaticContinuation: true } })
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    expect(f.turns[1]?.fingerprint.cwd).toBe(f.folder)
    await f.finish(1)
    expect(f.turns).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test("canceling after approval stops the task without a continuation", async () => {
  const f = await fixture()
  try {
    const approval = f.call()
    await f.answer()
    await approval
    const run = f.engine.activeRun({ threadId: "t" })
    if (!run) throw new Error("Run missing")
    f.engine.cancel(run.id)
    await waitFor(() => f.engine.listRuns("t", { all: true })[0]?.status === "canceled")
    await Bun.sleep(30)
    expect(f.turns).toHaveLength(1)
    expect(f.db.query("SELECT * FROM run_continuations").all()).toEqual([])
  } finally {
    await f.close()
  }
})

for (const decision of ["approved", "denied"] as const) {
  test(`browser ${decision} applies only the reviewed setting and continues the original task only after approval`, async () => {
    const previous = { bin: process.env.TOURI_CHROME_BIN, headless: process.env.TOURI_BROWSER_HEADLESS }
    process.env.TOURI_CHROME_BIN = process.execPath
    process.env.TOURI_BROWSER_HEADLESS = "1"
    const f = await fixture({ browserTask: true })
    try {
      const pending = f.call("capability_request", { capability: "browser", reason: "abrir a página solicitada" })
      const id = await f.answer(decision)
      expect(await pending).toMatchObject(
        decision === "approved"
          ? { success: true, structured: { automaticContinuation: true } }
          : { success: false, errorCode: "DENIED" },
      )
      expect(f.opened).toEqual([])
      expect(f.turns[0]?.bot.browserEnabled).toBe(false)
      await f.finish(0)
      if (decision === "approved") {
        await waitFor(() => f.turns.length === 2)
        expect(f.turns[1]?.bot).toMatchObject({ browserEnabled: true, computerUse: false, browser: "touri" })
        expect(f.turns[1]?.fingerprint.toolsetVersion).not.toBe(f.turns[0]?.fingerprint.toolsetVersion)
        expect(f.turns[1]?.session).toBeNull()
        expect(f.turns[1]?.input).toContainEqual({
          type: "text",
          text: expect.stringContaining("https://example.test/reference"),
        })
        await f.finish(1)
        expect(f.opened).toEqual(["https://example.test/reference"])
        expect(f.store.activePath({ threadId: "t" }).at(-1)?.text).toBe("Página aberta.")
      } else {
        expect(f.turns).toHaveLength(1)
        expect(f.opened).toEqual([])
        expect(f.store.getBot({ botId: "b" })?.browserEnabled).toBe(false)
      }
      expect(f.db.query("SELECT reason FROM run_continuations").all()).toEqual(
        decision === "approved" ? [{ reason: "permission_granted" }] : [],
      )
      expect(f.cards()).toHaveLength(1)
      expect(await f.engine.answerApproval({ approvalId: id, decision: "approved" })).toMatchObject({ success: false })
    } finally {
      await f.close()
      if (previous.bin === undefined) delete process.env.TOURI_CHROME_BIN
      else process.env.TOURI_CHROME_BIN = previous.bin
      if (previous.headless === undefined) delete process.env.TOURI_BROWSER_HEADLESS
      else process.env.TOURI_BROWSER_HEADLESS = previous.headless
    }
  })
}
