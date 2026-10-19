import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createEventBus, REPLAY_LIMITS } from "../../src/kernel/event-bus"
import type { PerformanceStageRunner } from "../../src/kernel/performance"
import { init as initStore } from "../../src/store"
import { socketTicket } from "../fakes/ws-ticket"

type WebSocketOptions = { headers: Record<string, string> }

const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-replay-"))
  const runtime = createKernel({ appData: root })
  const db = runtime.kernel.db as Database
  await initStore(runtime.kernel)
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  return {
    runtime,
    db,
    store,
    close: async () => {
      await runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const insertReply = (f: Awaited<ReturnType<typeof fixture>>): void => {
  f.store.insertMessage({
    message: {
      id: "reply",
      threadId: "t",
      parentId: null,
      role: "assistant",
      kind: "text",
      status: "streaming",
      runId: null,
      text: "",
      parts: [],
      sender: null,
      source: "local",
    },
  })
}

// A tool-heavy turn rewrites the whole reply after every command, and each command keeps its output.
const streamCommands = (f: Awaited<ReturnType<typeof fixture>>, count: number, outputBytes: number): void => {
  const parts: MessagePart[] = []
  for (let index = 0; index < count; index++) {
    parts.push({
      type: "command",
      callId: `call-${index}`,
      command: `echo ${index}`,
      cwd: "/tmp",
      exitCode: 0,
      outputTail: `${index}`.padEnd(outputBytes, "x"),
    } as MessagePart)
    f.store.updateMessage({ threadId: "t", messageId: "reply", patch: { parts: structuredClone(parts) } })
  }
}

const eventBytes = (db: Database): number =>
  (db.query("SELECT SUM(length(event_json)) AS n FROM ui_event_log").get() as { n: number }).n

test("streaming rewrites keep both journals bounded and hydrate the complete current projection", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    streamCommands(f, 60, 4_000)
    const transcriptBytes = (
      f.db.query("SELECT SUM(length(event_json)) AS n FROM transcript_entries").get() as { n: number }
    ).n
    // Copying each revision used ~60 * 30 * 4 KB in the transcript alone.
    // Both journals now retain only durable locators, independent of body size.
    expect(transcriptBytes).toBeLessThan(61 * 256)
    expect(eventBytes(f.db)).toBeLessThan(61 * 256)
    const bus = createEventBus(f.db)
    const replayed = bus.replay(0).filter(({ event }) => event.type === "message.updated")
    expect(replayed).toHaveLength(60)
    replayed.forEach(({ event }) => {
      if (event.type !== "message.updated") throw new Error("unexpected event")
      expect(event.message.parts).toHaveLength(60)
    })
    const headers = { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" }
    const base = `http://127.0.0.1:${f.runtime.handshake.port}/api/v1/threads/t/transcript`
    expect(await (await fetch(`${base}?since=0`, { headers })).json()).toMatchObject({ resync: true, entries: [] })
    const latest = await (await fetch(`${base}?since=60`, { headers })).json()
    expect(latest).toMatchObject({
      resync: false,
      entries: [{ seq: 61, event: { type: "message.updated", message: { id: "reply", updatedSeq: 61 } } }],
    })
    expect(latest.entries[0].event.message.parts).toHaveLength(60)
    bus.stop()
  } finally {
    await f.close()
  }
})

test("a reconnect gets each message once, in its latest revision, with contiguous sequence numbers", async () => {
  const f = await fixture()
  try {
    f.runtime.kernel.publish({ type: "import.progress", importId: "x", phase: "done", done: 1, total: 1 })
    insertReply(f)
    streamCommands(f, 20, 200)
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 20, delta: "Pronto" })
    await f.store.flushWritesAsync?.()
    const bus = createEventBus(f.db)
    const caughtUp = bus.catchUp(1)
    expect(caughtUp.map(({ seq }) => seq)).toEqual(bus.replay(1).map(({ seq }) => seq))
    const messages = caughtUp.filter(
      ({ event }) => event.type === "message.created" || event.type === "message.updated",
    )
    expect(messages).toHaveLength(1)
    const first = messages[0]?.event
    if (first?.type !== "message.created") throw new Error("expected the first position to keep its type")
    expect(first.message.parts).toHaveLength(21)
    expect(first.message.text).toBe("Pronto")
    expect(caughtUp.filter(({ event }) => event.type === "transcript.superseded")).toHaveLength(20)
    expect(caughtUp.at(-1)?.event).toMatchObject({ type: "message.delta", delta: "Pronto" })
    bus.stop()
  } finally {
    await f.close()
  }
})

test("cold clients and oversized gaps get one resync frame instead of the whole history", async () => {
  const f = await fixture()
  try {
    const line = "x".repeat(64 * 1024)
    const lines = [line]
    const publish = () => f.runtime.kernel.publish({ type: "process.log", processId: "p", lines })
    publish()
    const bus = createEventBus(f.db)
    const head = () => (bus.replay(0).at(-1) as UiEventEnvelope).seq
    expect(bus.catchUp(0)).toMatchObject([{ seq: head(), event: { type: "transcript.resync" } }])
    expect(bus.catchUp(head() - 1)).toHaveLength(1)
    const backlog = Math.ceil(REPLAY_LIMITS.bytes / line.length) + 1
    for (let index = 0; index < backlog; index++) publish()
    expect(bus.catchUp(1)).toEqual([{ seq: head(), at: expect.any(Number), event: { type: "transcript.resync" } }])
    bus.stop()
  } finally {
    await f.close()
  }
})

test("a gap with more events than the cap resyncs without reading the stored bodies back", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    streamCommands(f, 3, 10)
    const bus = createEventBus(f.db)
    const since = (bus.replay(0).at(-1) as UiEventEnvelope).seq
    for (let index = 0; index <= REPLAY_LIMITS.events; index++)
      f.runtime.kernel.publish({ type: "import.progress", importId: "x", phase: "done", done: index, total: 1 })
    const reads: string[] = []
    const query = f.db.query.bind(f.db)
    f.db.query = ((sql: string) => {
      reads.push(sql)
      return query(sql)
    }) as typeof f.db.query
    expect(bus.catchUp(since)).toMatchObject([{ event: { type: "transcript.resync" } }])
    expect(reads.some((sql) => sql.includes("event_json"))).toBe(false)
    f.db.query = query
    bus.stop()
  } finally {
    await f.close()
  }
})

test("a reference whose sequence now holds another entry falls back to the current message", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    streamCommands(f, 2, 10)
    const ref = f.db
      .query("SELECT seq FROM ui_event_log WHERE json_extract(event_json, '$.ref') = 1 LIMIT 1")
      .get() as {
      seq: number
    }
    const bus = createEventBus(f.db)
    const original = f.db.query.bind(f.db)
    f.db.query = ((sql: string) =>
      sql.startsWith("SELECT event_json FROM transcript_entries")
        ? { get: () => ({ event_json: JSON.stringify({ legacy: true, threadId: "t", messageId: "other" }) }) }
        : original(sql)) as typeof f.db.query
    const event = bus.replay(ref.seq - 1)[0]?.event
    f.db.query = original
    expect(event).toMatchObject({ type: "message.created", message: { id: "reply", parts: [{}, {}] } })
    bus.stop()
  } finally {
    await f.close()
  }
})

test("capturing an unpublished transcript releases its reader before checkpointing", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    f.db.exec("UPDATE messages SET text = 'Recuperado' WHERE id = 'reply'")
    const bus = createEventBus(f.db)
    expect(bus.replay(0).at(-1)?.event).toMatchObject({
      type: "message.updated",
      message: { text: "Recuperado" },
    })
    expect(f.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 })
    bus.stop()
  } finally {
    await f.close()
  }
})

test("synchronous publish and send survive a worker lock without an empty capture lock", async () => {
  const f = await fixture()
  const url = URL.createObjectURL(
    new Blob(
      [
        `import { Database } from "bun:sqlite";
        self.onmessage = ({ data }) => {
          const database = new Database(data.filename);
          database.exec("BEGIN IMMEDIATE");
          Atomics.store(new Int32Array(data.signal), 0, 1);
          self.postMessage("locked");
          setTimeout(() => {
            database.exec("ROLLBACK");
            Atomics.store(new Int32Array(data.signal), 0, 0);
            database.close();
            self.postMessage("released");
          }, 200);
        };`,
      ],
      { type: "application/javascript" },
    ),
  )
  const worker = new Worker(url, { smol: true, ref: false })
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const locked = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  worker.onmessage = ({ data }: MessageEvent<string>) => {
    if (data === "locked") locked.resolve()
    if (data === "released") released.resolve()
  }
  worker.onerror = (event) => locked.reject(new Error(event.message))
  worker.postMessage({ filename: f.db.filename, signal })
  let captureFinishedWhileLocked = false
  const runStage: PerformanceStageRunner = (stage, action, input) => {
    const result = action(input as Parameters<typeof action>[0])
    if (stage === "transcript_journal_capture")
      captureFinishedWhileLocked = Atomics.load(new Int32Array(signal), 0) === 1
    return result
  }
  const bus = createEventBus(f.db, runStage)
  try {
    await locked.promise

    expect(() =>
      bus.publish({ type: "import.progress", importId: "worker-lock", phase: "done", done: 1, total: 1 }),
    ).not.toThrow()
    const inserted = f.store.insertMessage({
      message: {
        id: "sent-while-locked",
        threadId: "t",
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "Mensagem sintética",
        parts: [{ type: "text", text: "Mensagem sintética" }],
        sender: null,
        source: "local",
      },
    })
    await released.promise

    expect(inserted.success).toBe(true)
    expect(captureFinishedWhileLocked).toBe(true)
    expect(
      bus.replay(0).some(({ event }) => event.type === "import.progress" && event.importId === "worker-lock"),
    ).toBe(true)
    expect((f.db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000)
  } finally {
    bus.stop()
    worker.terminate()
    URL.revokeObjectURL(url)
    await f.close()
  }
})

test("a socket reconnecting behind a large backlog stays open and receives live events promptly", async () => {
  const f = await fixture()
  const NativeSocket = WebSocket as unknown as { new (url: string, options: WebSocketOptions): WebSocket }
  let socket: WebSocket | undefined
  try {
    // Far more than the socket's 8 MB send buffer, which used to close the connection mid-replay.
    const lines = ["x".repeat(512 * 1024)]
    for (let index = 0; index < 40; index++) f.runtime.kernel.publish({ type: "process.log", processId: "p", lines })
    const port = f.runtime.handshake.port
    const ticket = await socketTicket(port, "/api/v1/events")
    const frames: Array<{ type?: string; seq?: number; event?: { type: string } }> = []
    let closed = false
    const live = new Promise<number>((resolve, reject) => {
      const started = Date.now()
      socket = new NativeSocket(`ws://127.0.0.1:${port}/api/v1/events?ticket=${ticket}&since=1`, {
        headers: { Origin: "tauri://localhost" },
      })
      socket.onclose = () => {
        closed = true
        reject(new Error("Event socket closed"))
      }
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data))
        frames.push(frame)
        if (frame.type === "resync")
          f.runtime.kernel.publish({ type: "import.progress", importId: "live", phase: "done", done: 1, total: 1 })
        if (frame.event?.type === "import.progress") resolve(Date.now() - started)
      }
    })
    expect(await live).toBeLessThan(2_000)
    expect(closed).toBe(false)
    expect(frames).toMatchObject([
      { type: "resync", lastSeq: 40 },
      { seq: 41, event: { type: "import.progress" } },
    ])
  } finally {
    socket?.close()
    await f.close()
  }
})
