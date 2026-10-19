import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, UiEventEnvelope } from "@touri/contracts"
import type { WebSocketOptions } from "bun"
import { createKernel } from "../../src/kernel"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { reapProviderProcesses, stopProviderChildren, trackProviderProcess } from "../../src/runtime/provider-processes"
import { init as initStore } from "../../src/store"
import { fakeProviderSpawn } from "../fakes/provider-spawn"
import { socketTicket } from "../fakes/ws-ticket"

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for transcript")
    await Bun.sleep(10)
  }
}

const fixture = async (ignoreTerm = false, interruptGraceMs = 30) => {
  const root = mkdtempSync(join(tmpdir(), "touri-recovery-"))
  // Keep mock provider files outside the protected application data tree.
  const assets = mkdtempSync(join(tmpdir(), "touri-recovery-provider-"))
  const scenario = join(assets, "scenario.json")
  const command = join(assets, "codex")
  const release = join(assets, "continue")
  const fake = join(assets, "fake-codex.ts")
  writeFileSync(fake, readFileSync(join(import.meta.dir, "../fakes/fake-codex.ts"), "utf8"))
  writeFileSync(
    command,
    `#!/bin/sh\nexport TOURI_FAKE_SCENARIO='${scenario}'\nexec '${process.execPath}' '${fake}' "$@"\n`,
  )
  chmodSync(command, 0o700)
  writeFileSync(
    scenario,
    JSON.stringify({ pauseAfterFirstDelta: release, ignoreInterrupt: true, deltas: ["INÍCIO", " meio", " FIM"] }),
  )
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  // These cases cover the manual recovery path; automatic continuation is covered in resume-interrupted.test.ts.
  db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex',?,1,1)").run(
    assets,
  )
  db.exec(`INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);
    INSERT INTO settings(key,value_json,updated_at) VALUES ('resumeInterruptedTurns','false',1);`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  let pid = 0
  const spawn = runtime.kernel.spawnTree
  runtime.kernel.spawnTree = fakeProviderSpawn(
    (args) => {
      const child = spawn(args)
      if (
        child.success &&
        (args.cmd === command || (args.cmd === "/usr/bin/sandbox-exec" && args.args[2] === command))
      ) {
        pid = child.pid
        if (ignoreTerm) {
          const kill = child.kill
          child.kill = (signal) => {
            if (signal !== "SIGTERM") kill(signal)
          }
        }
      }
      return child
    },
    command,
    scenario,
  )
  const engine = createRuntimeEngine({
    kernel: runtime.kernel,
    codexCommand: command,
    environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: scenario },
    interruptGraceMs,
  })
  const start = (): Run => {
    const request = store.insertMessage({
      message: {
        id: "request",
        threadId: "t",
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Resposta longa",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = engine.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    return result.run
  }
  return {
    root,
    assets,
    runtime,
    db,
    store,
    engine,
    command,
    scenario,
    resume: () => writeFileSync(release, ""),
    start,
    pid: () => pid,
    close: async () => {
      await engine.shutdown()
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
      rmSync(assets, { recursive: true, force: true })
    },
  }
}

test("a completed tool frame racing with cancellation keeps its result as completed_unobserved", async () => {
  const f = await fixture(false, 200)
  try {
    writeFileSync(
      f.scenario,
      JSON.stringify({
        pauseAfterFirstDelta: join(f.assets, "continue"),
        ignoreInterrupt: true,
        events: [
          {
            method: "item/started",
            params: { item: { type: "mcpToolCall", id: "racing-call", tool: "inspect", arguments: {} } },
          },
          {
            method: "item/completed",
            params: {
              item: {
                type: "mcpToolCall",
                id: "racing-call",
                tool: "inspect",
                status: "completed",
                result: "Resultado tardio",
              },
            },
          },
          { type: "complete" },
        ],
      }),
    )
    const run = f.start()
    await waitFor(() =>
      f.store
        .activePath({ threadId: "t" })
        .some((message) => message.parts.some((part) => "callId" in part && part.callId === "racing-call")),
    )
    f.engine.cancel(run.id)
    f.resume()
    await waitFor(() => f.engine.listRuns("t").some((item) => item.id === run.id && item.status === "canceled"))
    const reply = f.store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)
    expect(reply?.parts.find((part) => "callId" in part)).toMatchObject({
      resolution: "completed_unobserved",
      ok: true,
      outputJson: "Resultado tardio",
    })
    expect(f.db.query("SELECT resolution FROM tool_resolutions WHERE call_id='racing-call'").get()).toEqual({
      resolution: "completed_unobserved",
    })
  } finally {
    await f.close()
  }
})

test.each(["cancel", "restart"])(
  "%s settles a pending tool and supplies its disposition to the next model turn",
  async (reason) => {
    const f = await fixture()
    let restored: ReturnType<typeof createKernel> | undefined
    let recoveredEngine: ReturnType<typeof createRuntimeEngine> | undefined
    try {
      const requestLogPath = join(f.assets, "requests.jsonl")
      writeFileSync(
        f.scenario,
        JSON.stringify({
          pauseAfterFirstDelta: join(f.assets, "continue"),
          ignoreInterrupt: true,
          requestLogPath,
          events: [
            {
              method: "item/started",
              params: { item: { type: "mcpToolCall", id: "pending-call", tool: "inspect", arguments: {} } },
            },
          ],
        }),
      )
      const run = f.start()
      await waitFor(() =>
        f.store
          .activePath({ threadId: "t" })
          .some((message) => message.parts.some((part) => "callId" in part && part.callId === "pending-call")),
      )
      let store = f.store
      let engine = f.engine
      if (reason === "cancel") {
        engine.cancel(run.id)
        await waitFor(() => engine.listRuns("t").some((item) => item.id === run.id && item.status === "canceled"))
      } else {
        restored = createKernel({ appData: f.root })
        restored.kernel.spawnTree = fakeProviderSpawn(restored.kernel.spawnTree, f.command, f.scenario)
        await initStore(restored.kernel)
        const restoredStore = restored.kernel.services.use("store.api")
        if (!restoredStore) throw new Error("Store missing")
        store = restoredStore
        recoveredEngine = createRuntimeEngine({
          kernel: restored.kernel,
          codexCommand: f.command,
          environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: f.scenario },
          interruptGraceMs: 30,
        })
        engine = recoveredEngine
      }
      await engine.ready
      const disposition = reason === "cancel" ? "cancelled_by_user" : "interrupted_by_restart"
      const reply = store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)
      expect(reply?.parts.find((part) => "callId" in part)).toMatchObject({ resolution: disposition, ok: null })
      writeFileSync(f.scenario, JSON.stringify({ deltas: ["Retomado"], requestLogPath }))
      const request = store.insertMessage({
        message: {
          id: "followup",
          threadId: "t",
          parentId: reply?.id ?? null,
          role: "user",
          kind: "text",
          status: "complete",
          runId: null,
          text: "Continue",
          parts: [],
          sender: null,
          source: "local",
        },
      })
      if (!request.success) throw new Error(request.error)
      const next = engine.enqueue({ threadId: "t", requestMessageId: request.message.id, trigger: "user" })
      if (!next.success) throw new Error(next.error)
      await waitFor(() => engine.listRuns("t").some((item) => item.id === next.run.id && item.status === "succeeded"))
      const frames = (await Bun.file(requestLogPath).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const input = JSON.stringify(frames.filter((frame) => frame.method === "turn/start").at(-1)?.params.input)
      expect(input).toContain(disposition)
      expect(input).toContain("pending-call")
      expect(input).toContain("Verifique o estado antes de repetir")
    } finally {
      await recoveredEngine?.shutdown()
      await f.engine.shutdown()
      await restored?.stop()
      await f.close()
    }
  },
  30_000,
)

test("restart fences a still-streaming writer and kills its surviving local provider", async () => {
  const f = await fixture()
  let restored: ReturnType<typeof createKernel> | undefined
  let engine: ReturnType<typeof createRuntimeEngine> | undefined
  try {
    const run = f.start()
    await waitFor(() => f.store.activePath({ threadId: "t" }).some((message) => message.text === "INÍCIO"))
    const providerPid = f.pid()
    expect(providerPid).toBeGreaterThan(0)
    process.kill(providerPid, 0)
    restored = createKernel({ appData: f.root })
    restored.kernel.spawnTree = fakeProviderSpawn(restored.kernel.spawnTree, f.command, f.scenario)
    await initStore(restored.kernel)
    const store = restored.kernel.services.use("store.api")
    if (!store) throw new Error("Store missing")
    const events: UiEventEnvelope[] = []
    restored.kernel.subscribe((event) => events.push(event))
    engine = createRuntimeEngine({ kernel: restored.kernel })
    await engine.ready
    const recovered = store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)
    expect(recovered).toMatchObject({ status: "failed", text: "INÍCIO" })
    expect(recovered?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "app_restart" }))
    await waitFor(() => {
      try {
        process.kill(providerPid, 0)
        return false
      } catch {
        return true
      }
    })
    await Bun.sleep(600)
    expect(engine.listRuns("t")[0]).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
    expect(store.activePath({ threadId: "t" }).find((message) => message.id === recovered?.id)).toEqual(recovered)
    expect(
      events
        .filter(({ event }) => event.type === "run.updated")
        .map(({ event }) => (event.type === "run.updated" ? event.run.status : null)),
    ).toEqual(["interrupted"])
    const writer = createRuntimePersistence({ database: f.db })
    writer.saveRun({ ...run, status: "succeeded", errorClass: null, finishedAt: Date.now() })
    expect(engine.listRuns("t")[0]?.status).toBe("interrupted")
    // Losing runtime ownership also prevents the stale sidecar from starting queued work.
    const request = f.store.insertMessage({
      message: {
        id: "next",
        threadId: "t",
        parentId: recovered?.id ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Próxima",
        parts: [],
        sender: null,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const next = f.engine.enqueue({ threadId: "t", requestMessageId: "next", trigger: "user" })
    if (!next.success) throw new Error(next.error)
    await Bun.sleep(200)
    expect(engine.listRuns("t").find((row) => row.id === next.run.id)?.status).toBe("queued")
    expect(f.pid()).toBe(providerPid)
  } finally {
    await engine?.shutdown()
    await f.engine.shutdown()
    await restored?.stop()
    await f.close()
  }
}, 30_000)

for (const nativeSession of [false, true]) {
  test(`retry after app_restart requires review of recorded actions (native session: ${nativeSession})`, async () => {
    const f = await fixture()
    let restored: ReturnType<typeof createKernel> | undefined
    let engine: ReturnType<typeof createRuntimeEngine> | undefined
    try {
      if (nativeSession) {
        createRuntimePersistence({ database: f.db }).saveSession({
          id: "native-session",
          threadId: "t",
          provider: "codex",
          externalSessionId: "interrupted-native-thread",
          rolloutPath: null,
          fingerprint: "imported",
          state: "active",
          model: null,
          createdAt: 1,
          lastUsedAt: 1,
        })
      }
      const run = f.start()
      await waitFor(() => f.store.activePath({ threadId: "t" }).some((message) => message.text === "INÍCIO"))
      const partial = f.store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)
      if (!partial) throw new Error("Partial reply missing")
      f.store.updateMessage({
        threadId: "t",
        messageId: partial.id,
        patch: {
          parts: [
            ...partial.parts,
            {
              type: "command",
              callId: "completed-step",
              command: "echo etapa concluída",
              cwd: "/tmp",
              exitCode: 0,
              outputTail: "etapa concluída",
            },
          ],
        },
      })
      restored = createKernel({ appData: f.root })
      restored.kernel.spawnTree = fakeProviderSpawn(restored.kernel.spawnTree, f.command, f.scenario)
      await initStore(restored.kernel)
      const requests = join(f.assets, "retry-requests.jsonl")
      writeFileSync(f.scenario, JSON.stringify({ badResume: true, deltas: ["Continuação"], requestLogPath: requests }))
      engine = createRuntimeEngine({
        kernel: restored.kernel,
        codexCommand: f.command,
        environment: { PATH: process.env.PATH ?? "/usr/bin", TOURI_FAKE_SCENARIO: f.scenario },
      })
      await engine.ready
      expect(engine.listRuns("t")[0]).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
      const retried = engine.retry(run.id)
      expect(retried).toMatchObject({ success: false, errorCode: "CONFLICT" })
      await Bun.sleep(100)
      expect(engine.listRuns("t")).toHaveLength(1)
      expect(existsSync(requests)).toBe(false)
      expect(
        restored.kernel.services
          .use("store.api")
          ?.activePath({ threadId: "t" })
          .flatMap((message) => message.parts),
      ).toContainEqual(expect.objectContaining({ callId: "completed-step", exitCode: 0 }))
    } finally {
      await engine?.shutdown()
      await restored?.stop()
      await f.close()
    }
  }, 30_000)
}

test.each(["SIGTERM", "SIGTERM with stale parent", "shell crash", "orphan takeover"] as const)(
  "desktop %s preserves a recoverable app_restart and partial transcript",
  async (mode) => {
    const f = await fixture()
    // Only the launched sidecar owns maintenance; the seed fixture observes its database.
    f.runtime.kernel.services.use("storage.maintenance")?.dispose()
    const direct = mode.startsWith("SIGTERM")
    const environment = (inherited: NodeJS.ProcessEnv = process.env) => ({
      ...inherited,
      // Match the desktop launcher instead of inheriting or inferring a parent identity.
      TOURI_PARENT_PID: String(process.pid),
      TOURI_APP_DATA: f.root,
      TOURI_CODEX_BIN: f.command,
      TOURI_FAKE_SCENARIO: f.scenario,
      TOURI_HEADLESS: "1",
    })
    const child = Bun.spawn({
      cmd: direct
        ? [process.execPath, "run", join(import.meta.dir, "../../src/main.ts"), "serve"]
        : [process.execPath, "run", join(import.meta.dir, "../fakes/lifecycle-parent.ts")],
      env: environment(mode === "SIGTERM with stale parent" ? { ...process.env, TOURI_PARENT_PID: "1" } : process.env),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    let providerPid: number | undefined
    let sidecarPid: number | undefined
    let replacement: ReturnType<typeof Bun.spawn> | undefined
    try {
      const reader = child.stdout.getReader()
      let line = ""
      while (line.split("\n").length <= (direct ? 1 : 2)) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error(`Sidecar exited before handshake: ${await stderr}`)
        line += new TextDecoder().decode(chunk.value)
      }
      reader.releaseLock()
      const entries = line
        .trim()
        .split("\n")
        .map((entry) => JSON.parse(entry))
      const { port, pid } = entries[direct ? 0 : 1] as { port: number; pid: number }
      sidecarPid = pid
      const { token } = await Bun.file(join(f.runtime.kernel.paths.runDir, "handshake.json")).json()
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/threads/t/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "http://localhost:1420",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parentId: null,
          text: "Resposta longa",
          attachmentIds: [],
          clientNonce: "quit",
          deadline: Date.now() + 60_000,
        }),
      })
      expect(response.ok).toBe(true)
      // Read through the active sidecar: activePath materializes deltas and must
      // not compete with that process for a SQLite write transaction.
      await waitFor(async () => {
        const snapshot = await fetch(`http://127.0.0.1:${port}/api/v1/threads/t/messages`, {
          headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:1420" },
        })
        expect(snapshot.ok).toBe(true)
        const body = (await snapshot.json()) as { messages: Array<{ text: string }> }
        return body.messages.some((message) => message.text === "INÍCIO")
      })
      const records = readdirSync(join(f.runtime.kernel.paths.runDir, "provider-processes"))
      providerPid = Number(records[0]?.replace(".json", ""))
      expect(providerPid).toBeGreaterThan(0)
      if (mode === "orphan takeover") process.kill(pid, "SIGSTOP")
      child.kill(direct ? "SIGTERM" : "SIGKILL")
      if (direct) expect(await child.exited).toBe(0)
      else await child.exited
      if (mode === "orphan takeover") {
        replacement = Bun.spawn({
          cmd: [process.execPath, "run", join(import.meta.dir, "../../src/main.ts"), "serve"],
          env: environment(),
          stdout: "pipe",
          stderr: "pipe",
        })
      }
      await waitFor(() => f.engine.listRuns("t")[0]?.errorClass === "app_restart")
      expect(f.engine.listRuns("t")[0]).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
      const reply = f.store.activePath({ threadId: "t" }).find((message) => message.role === "assistant")
      expect(reply).toMatchObject({ status: "failed", text: "INÍCIO" })
      expect(reply?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "app_restart" }))
      // Transcript recovery can be visible before asynchronous startup cleanup finishes.
      await waitFor(() => {
        try {
          process.kill(providerPid as number, 0)
          return false
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
          return true
        }
      })
      expect(() => process.kill(providerPid as number, 0)).toThrow()
      await Bun.sleep(600)
      expect(f.store.activePath({ threadId: "t" }).find((message) => message.id === reply?.id)).toEqual(reply)
    } catch (error) {
      child.kill("SIGKILL")
      await child.exited
      const logPath = join(f.root, "logs/sidecar.log")
      throw new Error(
        `${error instanceof Error ? error.stack : String(error)}\n${await stderr}\n${existsSync(logPath) ? readFileSync(logPath, "utf8") : "(sidecar log not created)"}`,
      )
    } finally {
      child.kill("SIGKILL")
      await child.exited
      if (sidecarPid && !direct) {
        try {
          process.kill(sidecarPid, "SIGKILL")
        } catch {}
      }
      replacement?.kill("SIGTERM")
      await replacement?.exited
      await stderr
      if (providerPid) {
        try {
          process.kill(-providerPid, "SIGKILL")
        } catch {}
      }
      await f.close()
    }
  },
  30_000,
)

test("orphan cleanup verifies process birth before signaling a reused PID", async () => {
  const f = await fixture()
  const child = f.runtime.kernel.spawnTree({
    cmd: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: f.root,
    env: {},
  })
  if (!child.success) throw new Error(child.error)
  try {
    await trackProviderProcess(f.runtime.kernel, child)
    const path = join(f.runtime.kernel.paths.runDir, "provider-processes", `${child.pid}.json`)
    const record = await Bun.file(path).json()
    writeFileSync(path, JSON.stringify({ ...record, birth: "a different process birth" }))
    await reapProviderProcesses(f.runtime.kernel)
    process.kill(child.pid, 0)
    expect(readdirSync(join(f.runtime.kernel.paths.runDir, "provider-processes"))).toEqual([])
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await f.close()
  }
}, 30_000)

test("provider completion racing with quit cannot turn an interrupted prefix into success", async () => {
  const f = await fixture(true)
  try {
    const run = f.start()
    await waitFor(() => f.store.activePath({ threadId: "t" }).some((message) => message.text === "INÍCIO"))
    const shutdown = f.engine.shutdown()
    f.resume()
    await waitFor(() => f.engine.listRuns("t")[0]?.finishedAt !== null)
    expect(f.engine.listRuns("t")[0]).toMatchObject({ status: "interrupted", errorClass: "app_restart" })
    expect(f.store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)).toMatchObject({
      status: "failed",
      text: "INÍCIO",
    })
    await shutdown
  } finally {
    await f.close()
  }
}, 30_000)

test("shutdown observes a dead provider even if Bun misses its exit notification", async () => {
  const f = await fixture()
  const child = f.runtime.kernel.spawnTree({
    cmd: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: f.root,
    env: {},
  })
  if (!child.success) throw new Error(child.error)
  try {
    await child.exited
    const children = new Set([
      {
        ...child,
        exited: new Promise<{ code: number | null; signal: string | null }>(() => {}),
        kill: () => undefined,
      },
    ])
    await stopProviderChildren(children)
    expect(children.size).toBe(0)
  } finally {
    await f.close()
  }
}, 30_000)

test("restart with a dead provider produces a terminal reply even before the first delta", async () => {
  const f = await fixture()
  let recovered: ReturnType<typeof createRuntimeEngine> | undefined
  try {
    const run = f.start()
    // Model a crashed sidecar that persisted delivery/start but never received output.
    await f.engine.shutdown()
    f.db
      .query("UPDATE runs SET status = 'starting', reply_message_id = NULL, finished_at = NULL WHERE id = ?")
      .run(run.id)
    recovered = createRuntimeEngine({ kernel: f.runtime.kernel })
    await recovered.ready
    const reply = f.store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)
    expect(reply).toMatchObject({ status: "failed", text: "", parentId: "request" })
    expect(reply?.parts).toContainEqual(expect.objectContaining({ type: "notice", code: "app_restart" }))
    expect(recovered.listRuns("t")[0]).toMatchObject({ status: "interrupted", replyMessageId: reply?.id })
    expect(f.db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 1 })
  } finally {
    await recovered?.shutdown()
    await f.close()
  }
}, 30_000)

test("UI reconnect mid-stream replays from seq while the surviving sidecar keeps the run active", async () => {
  const f = await fixture()
  let first: WebSocket | undefined
  let second: WebSocket | undefined
  try {
    const events: UiEventEnvelope[] = []
    const cursors: number[] = []
    // Use the token written for this isolated kernel, just as the desktop endpoint does.
    const handshake = await Bun.file(join(f.runtime.kernel.paths.runDir, "handshake.json")).json()
    const connect = async (since: number) => {
      const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
      const ticket = await socketTicket(f.runtime.handshake.port, "/api/v1/events", handshake.token)
      const socket = new NativeSocket(
        `ws://127.0.0.1:${f.runtime.handshake.port}/api/v1/events?ticket=${ticket}&since=${since}`,
        { headers: { Origin: "http://localhost:1420" } },
      )
      socket.onmessage = (frame) => {
        const data = JSON.parse(String(frame.data))
        // A cold connection starts at the head with a resync frame instead of replaying history.
        if (data.type === "resync") cursors.push(data.lastSeq)
        else events.push(data)
      }
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        socket.onerror = reject
      })
      return socket
    }
    first = await connect(0)
    await waitFor(() => cursors.length === 1)
    const run = f.start()
    await waitFor(() => events.some(({ event }) => event.type === "message.delta"))
    const seq = events.at(-1)?.seq ?? 0
    first.close()
    const beforeReconnect = events.length
    expect(f.engine.activeRun({ threadId: "t" })?.status).toBe("running")
    second = await connect(seq)
    f.resume()
    await waitFor(() => events.some(({ event }) => event.type === "run.updated" && event.run.status === "succeeded"))
    const replay = events.slice(beforeReconnect)
    expect(replay.every((event) => event.seq > seq)).toBe(true)
    expect(new Set(replay.map((event) => event.seq)).size).toBe(replay.length)
    expect(replay.some(({ event }) => event.type === "run.updated" && event.run.status === "canceled")).toBe(false)
    expect(cursors).toHaveLength(1)
    expect(f.store.activePath({ threadId: "t" }).find((message) => message.runId === run.id)).toMatchObject({
      status: "complete",
      text: "INÍCIO meio FIM",
    })
  } finally {
    first?.close()
    second?.close()
    await f.close()
  }
}, 30_000)
