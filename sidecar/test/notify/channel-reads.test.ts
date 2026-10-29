import type { Database } from "bun:sqlite"
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChannelPerson, MessageSender, Run, UiEvent } from "@touri/contracts"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createChannelReads } from "../../src/notify/channel-reads"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

setDefaultTimeout(20_000)

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Synthetic turn did not finish")
    await Bun.sleep(10)
  }
}

const people: ChannelPerson[] = [
  { id: "owner", name: "Você", handle: "thiago", avatarSeed: "owner", role: "admin" },
  { id: "ana", name: "Ana", handle: "ana", avatarSeed: "ana", role: "member" },
]
const owner = { id: "owner", role: "admin" as const }
const ana = { id: "ana", role: "member" as const }

/** A real channel runtime whose member bot replies with the text the test chooses. */
const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-channel-reads-"))
  const host = createKernel({ appData: root })
  const closeHost = async () => {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  }
  cleanups.add(closeHost)
  await initStore(host.kernel)
  await initNotify(host.kernel)
  host.kernel.services.provide("work.channelPeople", () => people)
  // Ana is a channel member; Bia has no access to it.
  host.kernel.services.provide("work.canAccessThread", ({ personId }) => personId === "ana")
  const db = host.kernel.db as Database
  const store = host.kernel.services.use("store.api")
  if (!store) throw new Error("Store missing")
  const botId = host.kernel.newId()
  db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,'Lia','codex',?,1,1)").run(
    botId,
    root,
  )
  const groups = createGroupStore(host.kernel)
  const group = groups.save({
    name: "avisos",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [botId],
    coordinatorBotId: null,
  })
  const thread = groups.createThread(group)
  const persistence = createRuntimePersistence({ database: db })
  const replies: string[] = []
  const finish = (run: Run, patch: Partial<Run>) => {
    const updated = { ...run, ...patch }
    persistence.saveRun(updated)
    host.kernel.publish({ type: "run.updated", run: updated })
  }
  const engine = {
    ready: Promise.resolve(),
    enqueue: (args: { threadId: string; requestMessageId: string; trigger: Run["trigger"] }) => {
      const run: Run = {
        id: host.kernel.newId(),
        threadId: args.threadId,
        requestMessageId: args.requestMessageId,
        botId: store.getThread({ threadId: args.threadId })?.botId ?? "",
        provider: "codex",
        trigger: args.trigger,
        status: "queued",
        replyMessageId: null,
        externalTurnId: null,
        errorClass: null,
        errorMessage: null,
        usage: null,
        routineRunId: null,
        queuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      }
      persistence.saveRun(run)
      queueMicrotask(() => {
        finish(run, { status: "running", startedAt: Date.now() })
        const text = replies.shift() ?? "Feito."
        const reply = store.insertMessage({
          message: {
            id: host.kernel.newId(),
            threadId: run.threadId,
            parentId: args.requestMessageId,
            role: "assistant",
            kind: "text",
            status: "complete",
            runId: run.id,
            text,
            parts: [{ type: "text", text }],
            sender: null,
            source: "local",
          },
        })
        if (!reply.success) throw new Error(reply.error)
        finish(run, { status: "succeeded", replyMessageId: reply.message.id, finishedAt: Date.now() })
      })
      return { success: true as const, run }
    },
    cancel: (id: string) => {
      const run = persistence.getRun(id)
      if (!run) return { success: false as const, errorCode: "NOT_FOUND" as const, error: "Missing run" }
      return { success: true as const, run }
    },
  }
  const runtime = createGroupRuntime(host.kernel, engine, undefined, 1)
  cleanups.add(async () => {
    runtime.shutdown()
    await runtime.waitForDrain()
    await closeHost()
  })
  cleanups.delete(closeHost)
  const events: UiEvent[] = []
  const unsubscribe = host.kernel.subscribe(({ event }) => {
    if (event.type === "channel.read") events.push(event)
  })
  cleanups.add(async () => unsubscribe())
  /** One channel request; the member bot answers with `reply`. */
  const ask = async (reply: string, sender: MessageSender | null = null) => {
    replies.push(reply)
    const request = store.insertMessage({
      message: {
        id: host.kernel.newId(),
        threadId: thread.id,
        parentId: store.getThread({ threadId: thread.id })?.activeLeafId ?? null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: "@Lia confira o plano",
        parts: [{ type: "text", text: "@Lia confira o plano" }],
        sender,
        source: "local",
      },
    })
    if (!request.success) throw new Error(request.error)
    const result = runtime.enqueue({ threadId: thread.id, requestMessageId: request.message.id, trigger: "user" })
    if (!result.success) throw new Error(result.error)
    await until(() => persistence.getRun(result.run.id)?.status === "succeeded")
  }
  // Settled replies are compared by millisecond; keep later reads strictly after earlier replies.
  const tick = () => Bun.sleep(5)

  return { host, db, store, group, thread, reads: createChannelReads(host.kernel), ask, tick, events }
}

test("a finished bot reply stays unread for each person until that person reads the channel", async () => {
  const f = await getFixture()
  expect(f.reads.list(owner)).toEqual([expect.objectContaining({ threadId: f.thread.id, unread: 0, mentions: 0 })])

  await f.ask("Plano conferido.")

  // The local owner asked for this task, so its end is a mention for them and plain news for Ana.
  expect(f.reads.list(owner)).toEqual([expect.objectContaining({ unread: 1, mentions: 1 })])
  expect(f.reads.list(ana)).toEqual([expect.objectContaining({ unread: 1, mentions: 0 })])

  await f.tick()
  const read = f.reads.markRead(owner, { id: f.thread.id, group_id: f.group.id })

  expect(read).toEqual(expect.objectContaining({ unread: 0, mentions: 0 }))
  expect(f.events).toEqual([{ type: "channel.read", personId: "owner", threadId: f.thread.id, readAt: read.readAt }])
  // Reading is personal: Ana still has the reply waiting.
  expect(f.reads.list(ana)).toEqual([expect.objectContaining({ unread: 1, mentions: 0 })])
})

test("a reply that mentions someone or ends their own request is a mention for them only", async () => {
  const f = await getFixture()

  await f.ask("Pronto, @thiago confira o mapa.", { id: "ana", name: "Ana", kind: "person" })
  await f.ask("Nada novo por aqui.", { id: "ana", name: "Ana", kind: "person" })

  // Owner: two unread replies, one of which names them.
  expect(f.reads.list(owner)).toEqual([expect.objectContaining({ unread: 2, mentions: 1 })])
  // Ana asked for both tasks, so both of their ends are mentions for her.
  expect(f.reads.list(ana)).toEqual([expect.objectContaining({ unread: 2, mentions: 2 })])
  expect(f.reads.list({ id: "bia", role: "member" })).toEqual([])
})

test("integration requests and archived channels are never counted as the person's own tasks", async () => {
  const f = await getFixture()

  await f.ask("Alerta tratado.", { id: "monitor", name: "Monitor", kind: "integration" })

  expect(f.reads.list(owner)).toEqual([expect.objectContaining({ unread: 1, mentions: 0 })])

  f.db.query("UPDATE threads SET archived_at = ? WHERE id = ?").run(Date.now(), f.thread.id)

  expect(f.reads.list(owner)).toEqual([])
})

test("a read position never moves back, and only replies settled after it count", async () => {
  const f = await getFixture()
  await f.ask("Primeira resposta.")
  await f.tick()
  const first = f.reads.markRead(owner, { id: f.thread.id, group_id: f.group.id })
  f.db.query("UPDATE channel_reads SET read_at = ? WHERE person_id = 'owner'").run(first.readAt + 60_000)

  const again = f.reads.markRead(owner, { id: f.thread.id, group_id: f.group.id })

  expect(again.readAt).toBe(first.readAt + 60_000)
  f.db.query("UPDATE channel_reads SET read_at = ? WHERE person_id = 'owner'").run(first.readAt)
  await f.tick()
  await f.ask("Segunda resposta.")

  expect(f.reads.list(owner)).toEqual([expect.objectContaining({ unread: 1, mentions: 1 })])
})
