import type { Database } from "bun:sqlite"
import { expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, ProviderAdapter, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
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

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-permission-continuation-"))
  const folder = join(root, "notes")
  const reference = join(root, "reference")
  mkdirSync(folder)
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
      const canWrite = writableTurnFolders(args).includes(folder)
      if (canWrite && !args.signal.aborted) writeFileSync(join(folder, "notas.md"), "teste")
      args.onEvent({ type: "text_delta", itemId: "reply", delta: canWrite ? "teste" : "Acesso pendente." })
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
  runtime.kernel.services.provide("approvals.present", engine.approvalBridge.present)
  runtime.kernel.services.provide("runtime.continueAfterApproval", engine.continueAfterApproval)
  const projects = createProjectStore({ kernel: runtime.kernel })
  runtime.kernel.services.provide("projects.info", async ({ projectId }) => {
    const project = projects.getProject(projectId)
    return project ? { project, git: null, hints: [], processes: [], previews: [], secretNames: [] } : null
  })
  const tools = createSetupTools({ kernel: runtime.kernel, store: projects })
  const send = () => {
    const message = store.insertMessage({
      message: {
        id: runtime.kernel.newId(),
        threadId: "t",
        parentId: store.getThread({ threadId: "t" })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: requestText,
        parts: [{ type: "text", text: requestText }],
        sender: null,
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
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
  send()
  await waitFor(() => turns.length === 1)
  return { folder, reference, turns, db, store, engine, call, answer, finish, close }
}

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

test("reapproving the same scope in the continuation cannot loop", async () => {
  const f = await fixture()
  try {
    const first = f.call()
    await f.answer()
    await first
    await f.finish(0)
    await waitFor(() => f.turns.length === 2)
    const repeated = f.call()
    await f.answer()
    expect(await repeated).toMatchObject({ success: true, structured: { automaticContinuation: false } })
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
