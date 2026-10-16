import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessagePart, UiEventEnvelope } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createEventBus, REPLAY_LIMITS } from "../../src/kernel/event-bus"
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
    close: () => {
      runtime.stop()
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

test("streaming rewrites keep the replay log linear and still replay the exact revisions", async () => {
  const f = await fixture()
  try {
    insertReply(f)
    streamCommands(f, 60, 4_000)
    const transcriptBytes = (
      f.db.query("SELECT SUM(length(event_json)) AS n FROM transcript_entries").get() as { n: number }
    ).n
    // Every revision copied into the replay log would be ~60 * 30 * 4 KB; references stay tiny.
    expect(eventBytes(f.db)).toBeLessThan(transcriptBytes / 50)
    const bus = createEventBus(f.db)
    const replayed = bus.replay(0).filter(({ event }) => event.type === "message.updated")
    expect(replayed).toHaveLength(60)
    replayed.forEach(({ event }, index) => {
      if (event.type !== "message.updated") throw new Error("unexpected event")
      expect(event.message.parts).toHaveLength(index + 1)
    })
    bus.stop()
  } finally {
    f.close()
  }
})

test("a reconnect gets each message once, in its latest revision, with contiguous sequence numbers", async () => {
  const f = await fixture()
  try {
    f.runtime.kernel.publish({ type: "import.progress", importId: "x", phase: "done", done: 1, total: 1 })
    insertReply(f)
    streamCommands(f, 20, 200)
    f.store.appendDelta({ threadId: "t", messageId: "reply", partIndex: 20, delta: "Pronto" })
    const bus = createEventBus(f.db)
    const caughtUp = bus.catchUp(1)
    expect(caughtUp.map(({ seq }) => seq)).toEqual(bus.replay(1).map(({ seq }) => seq))
    const messages = caughtUp.filter(
      ({ event }) => event.type === "message.created" || event.type === "message.updated",
    )
    expect(messages).toHaveLength(1)
    const first = messages[0]?.event
    if (first?.type !== "message.created") throw new Error("expected the first position to keep its type")
    expect(first.message.parts).toHaveLength(20)
    expect(caughtUp.filter(({ event }) => event.type === "transcript.superseded")).toHaveLength(20)
    expect(caughtUp.at(-1)?.event).toMatchObject({ type: "message.delta", delta: "Pronto" })
    bus.stop()
  } finally {
    f.close()
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
    f.close()
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
    f.close()
  }
})
