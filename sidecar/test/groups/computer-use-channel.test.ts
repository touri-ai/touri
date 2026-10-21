import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, Run, ToolContext, UiEvent, UiEventEnvelope } from "@touri/contracts"
import {
  canControlChannelBrowserRun,
  createChannelBrowserRuns,
  getNeedsYouRecipient,
  getNextChannelBrowserRun,
  getRequesterPersonId,
} from "../../src/browser/channel-runs"
import { openDatabase } from "../../src/kernel/db"

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-computer-use-channel-"))
  const database = openDatabase({ filename: join(root, "test.db") })
  const subscribers = new Set<(envelope: UiEventEnvelope) => void>()
  const notifications: Array<Record<string, unknown>> = []
  const resumptions: Array<{ runId: string }> = []
  const kernel = {
    db: database,
    services: {
      use: (name: string) => {
        if (name === "work.personName") return (personId: string) => ({ ana: "Ana", owner: "Thiago" })[personId] ?? null
        if (name === "work.personChannelIds") return () => ["travel"]
        if (name === "work.defaultPersonId") return () => "owner"
        if (name === "notify.emit")
          return (input: Record<string, unknown>) => {
            notifications.push(input)
            return {}
          }
        if (name === "runtime.resumeAfterBrowserTakeover")
          return (input: { runId: string }) => {
            resumptions.push(input)
            return true
          }
        if (name === "notify.resolve") return () => undefined
        return null
      },
    },
    publish: (event: UiEvent) => {
      subscribers.forEach((listener) => {
        listener({ seq: 1, at: 1, event })
      })
    },
    subscribe: (listener: (envelope: UiEventEnvelope) => void) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    redact: (value: string) => value,
  } as unknown as Kernel
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
      VALUES ('leo','Léo','codex','/tmp/leo',1,1,'owner'), ('bia-bot','Bia','codex','/tmp/bia',1,1,'owner');
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('travel','Viagem','#888888','circle','travel',1,1);
    INSERT INTO group_members(group_id,bot_id,position) VALUES ('travel','leo',0), ('travel','bia-bot',1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id)
      VALUES ('channel','leo','Viagem',1,1,'travel'), ('channel-2','leo','Viagem 2',1,1,'travel');
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('channel-leo','leo','Viagem',1,1,'travel','channel'), ('channel-bia','bia-bot','Viagem',1,1,'travel','channel'),
        ('channel-2-leo','leo','Viagem 2',1,1,'travel','channel-2');
  `)
  const addRun = ({ runId, botId, threadId }: { runId: string; botId: string; threadId: string }): void => {
    database
      .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,requester_person_id)
        VALUES (?, ?, ?, 'codex', 'user', 'running', 1, 'ana')`)
      .run(runId, threadId, botId)
  }
  const publishRunStatus = (runId: string, status: "succeeded" | "failed" | "canceled"): void => {
    kernel.publish({ type: "run.updated", run: { id: runId, status } as Run })
  }
  const context = (runId: string, botId: string, threadId: string): ToolContext =>
    ({ runId, botId, threadId, signal: new AbortController().signal }) as ToolContext
  const cleanup = (): void => {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }

  return { database, kernel, notifications, resumptions, addRun, publishRunStatus, context, cleanup }
}

test("a channel run keeps the person who sent its triggering message", () => {
  expect(getRequesterPersonId({ id: "ana", kind: "person" })).toBe("ana")
  expect(getRequesterPersonId({ id: "leo" })).toBeNull()
  expect(getRequesterPersonId(null)).toBeNull()
})

test("only the requester or responsible person can control a channel browser run", () => {
  const run = {
    requesterPersonId: "ana",
    responsiblePersonId: "thiago",
  }

  expect(canControlChannelBrowserRun({ ...run, actorPersonId: "ana" })).toBe(true)
  expect(canControlChannelBrowserRun({ ...run, actorPersonId: "thiago" })).toBe(true)
  expect(canControlChannelBrowserRun({ ...run, actorPersonId: "bia" })).toBe(false)
})

test("browser needs-you escalation targets the requester first and the bot owner after the delay", () => {
  const request = {
    requesterPersonId: "ana",
    responsiblePersonId: "thiago",
    needsYouAt: 1_000,
    escalationMs: 300_000,
  }

  expect(getNeedsYouRecipient({ ...request, now: 300_999 })).toBe("ana")
  expect(getNeedsYouRecipient({ ...request, now: 301_000 })).toBe("thiago")
  expect(getNeedsYouRecipient({ ...request, responsiblePersonId: "ana", now: 301_000 })).toBe("ana")
})

test("channel browser runs persist one active slot per bot and promote queued work in order", async () => {
  const fixture = createFixture()
  const { database, kernel, addRun, publishRunStatus, context, cleanup } = fixture
  const channelRuns = createChannelBrowserRuns({ kernel, database })
  try {
    addRun({ runId: "leo-1", botId: "leo", threadId: "channel-leo" })
    addRun({ runId: "leo-2", botId: "leo", threadId: "channel-leo" })
    addRun({ runId: "leo-3", botId: "leo", threadId: "channel-leo" })
    addRun({ runId: "leo-4", botId: "leo", threadId: "channel-leo" })
    addRun({ runId: "bia-1", botId: "bia-bot", threadId: "channel-bia" })
    addRun({ runId: "leo-other-channel", botId: "leo", threadId: "channel-2-leo" })
    expect(await channelRuns.enter(context("leo-1", "leo", "channel-leo"))).toEqual({ success: true })
    const second = channelRuns.enter(context("leo-2", "leo", "channel-leo"))
    const third = channelRuns.enter(context("leo-3", "leo", "channel-leo"))
    const fourth = channelRuns.enter(context("leo-4", "leo", "channel-leo"))
    expect(await channelRuns.enter(context("bia-1", "bia-bot", "channel-bia"))).toEqual({ success: true })
    const otherChannel = channelRuns.enter(context("leo-other-channel", "leo", "channel-2-leo"))
    expect(channelRuns.list(["travel"]).map((run) => [run.runId, run.status, run.queuePosition])).toEqual([
      ["bia-1", "running", null],
      ["leo-1", "running", null],
      ["leo-2", "queued", 1],
      ["leo-3", "queued", 2],
      ["leo-4", "queued", 3],
      ["leo-other-channel", "queued", 4],
    ])

    expect(await second).toEqual({ success: true, queued: true })
    publishRunStatus("leo-2", "succeeded")
    expect(channelRuns.get("leo-2")?.status).toBe("queued")
    publishRunStatus("leo-1", "succeeded")
    expect(fixture.resumptions.map((run) => run.runId)).toEqual(["leo-2"])
    publishRunStatus("leo-1", "succeeded")
    expect(fixture.resumptions).toHaveLength(1)
    publishRunStatus("leo-2", "succeeded")
    expect(channelRuns.get("leo-2")?.status).toBe("running")
    expect(await second).toEqual({ success: true, queued: true })
    expect(channelRuns.get("leo-2")?.status).toBe("running")
    database
      .query(`INSERT INTO browser_tabs
        (id,profile,owner_bot_id,owner_thread_id,url,state,created_at,last_used_at)
        VALUES ('leo-tab','default','leo','channel-leo','https://example.com','live',1,1)`)
      .run()
    expect(channelRuns.takeControl({ runId: "leo-2", actorPersonId: "intruder" })).toMatchObject({ success: false })
    expect(channelRuns.takeControl({ runId: "leo-2", actorPersonId: "ana" })).toEqual({ success: true })
    expect(channelRuns.getForTab("leo-tab")?.controllerName).toBe("Ana")
    expect(channelRuns.isPreviewHidden("leo-tab")).toBe(true)
    expect(channelRuns.returnControl({ runId: "leo-2", actorPersonId: "ana" })).toEqual({ success: true })
    expect(channelRuns.isPreviewHidden("leo-tab")).toBe(false)

    publishRunStatus("leo-3", "canceled")
    await expect(third).resolves.toMatchObject({ success: true, queued: true })
    expect(channelRuns.get("leo-3")?.status).toBe("canceled")
    expect(channelRuns.get("leo-4")).toMatchObject({ status: "queued", queuePosition: 1 })
    addRun({ runId: "leo-2-resumed", botId: "leo", threadId: "channel-leo" })
    database.exec("INSERT INTO browser_takeover_continuations VALUES ('leo-2-resumed','leo-2','leo-2',2)")
    publishRunStatus("leo-2-resumed", "succeeded")
    expect(await fourth).toEqual({ success: true, queued: true })
    expect(channelRuns.get("leo-4")?.status).toBe("running")
    addRun({ runId: "leo-4-resumed", botId: "leo", threadId: "channel-leo" })
    database.exec("INSERT INTO browser_takeover_continuations VALUES ('leo-4-resumed','leo-4','leo-4',3)")
    publishRunStatus("leo-4-resumed", "succeeded")
    publishRunStatus("bia-1", "succeeded")
    expect(await otherChannel).toEqual({ success: true, queued: true })
    addRun({ runId: "leo-other-resumed", botId: "leo", threadId: "channel-2-leo" })
    database.exec(
      "INSERT INTO browser_takeover_continuations VALUES ('leo-other-resumed','leo-other-channel','leo-other-channel',4)",
    )
    publishRunStatus("leo-other-resumed", "succeeded")
    expect(channelRuns.list(["travel"])).toEqual([])
  } finally {
    channelRuns.dispose()
    cleanup()
  }
})

test("a channel needs-you notification is addressed to the requester", async () => {
  const fixture = createFixture()
  const { database, kernel, notifications, addRun, context, cleanup } = fixture
  const channelRuns = createChannelBrowserRuns({ kernel, database, escalationMs: 300_000, now: () => 1000 })
  try {
    addRun({ runId: "needs-you", botId: "leo", threadId: "channel-leo" })
    await expect(channelRuns.enter(context("needs-you", "leo", "channel-leo"))).resolves.toEqual({ success: true })
    expect(channelRuns.needsYou("needs-you", "The page needs a person")).toBe(true)
    expect(notifications).toMatchObject([{ targetPersonId: "ana", requestId: "browser-needs-you:needs-you" }])
    expect(channelRuns.get("needs-you")?.status).toBe("needs_you")
  } finally {
    channelRuns.dispose()
    cleanup()
  }
})

test("a channel needs-you notification escalates to the responsible person after its configured delay", async () => {
  const fixture = createFixture()
  const { database, kernel, notifications, addRun, context, cleanup } = fixture
  let currentTime = 1_000
  const channelRuns = createChannelBrowserRuns({
    kernel,
    database,
    escalationMs: 10,
    now: () => currentTime,
  })
  let resolveEscalation = () => {}
  const escalated = new Promise<void>((resolve) => {
    resolveEscalation = resolve
  })
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "browser.channel_run" && event.run.escalatedAt !== null) resolveEscalation()
  })
  try {
    addRun({ runId: "needs-you-escalates", botId: "leo", threadId: "channel-leo" })
    await expect(channelRuns.enter(context("needs-you-escalates", "leo", "channel-leo"))).resolves.toEqual({
      success: true,
    })
    expect(channelRuns.needsYou("needs-you-escalates", "The page needs a person")).toBe(true)
    currentTime = 1_010
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        escalated,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Browser needs-you escalation timed out")), 1_000)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    expect(notifications).toMatchObject([
      { targetPersonId: "ana", requestId: "browser-needs-you:needs-you-escalates" },
      { targetPersonId: "owner", requestId: "browser-needs-you:needs-you-escalates:owner" },
    ])
    expect(channelRuns.get("needs-you-escalates")?.escalatedAt).toBe(1_010)
  } finally {
    unsubscribe()
    channelRuns.dispose()
    cleanup()
  }
})

test("the browser queue serializes one bot in a channel while another bot stays eligible", () => {
  const first = { runId: "a1", channelId: "channel-1", botId: "leo", queuedAt: 1 }
  const second = { runId: "a2", channelId: "channel-1", botId: "leo", queuedAt: 2 }
  const otherBot = { runId: "b1", channelId: "channel-1", botId: "ana-bot", queuedAt: 3 }
  const active = new Set(["leo"])

  expect(getNextChannelBrowserRun({ queued: [first, second, otherBot], active })).toEqual(otherBot)
  expect(getNextChannelBrowserRun({ queued: [first, second], active: new Set() })).toEqual(first)
})

const additionalCleanups = new Set<() => void>()
afterEach(() => {
  additionalCleanups.forEach((cleanup) => {
    cleanup()
  })
  additionalCleanups.clear()
})

test("one browser request spans a continuation while channels and a DM wait for the same bot", async () => {
  const fixture = createFixture()
  const { database, kernel, addRun, publishRunStatus, context } = fixture
  const channelRuns = createChannelBrowserRuns({ kernel, database })
  additionalCleanups.add(() => {
    channelRuns.dispose()
    fixture.cleanup()
  })
  database.exec("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('dm','leo','Private task',1,1)")
  addRun({ runId: "first", botId: "leo", threadId: "channel-leo" })
  addRun({ runId: "other-channel", botId: "leo", threadId: "channel-2-leo" })
  addRun({ runId: "direct", botId: "leo", threadId: "dm" })
  addRun({ runId: "independent", botId: "bia-bot", threadId: "channel-bia" })

  expect(await channelRuns.enter(context("first", "leo", "channel-leo"))).toEqual({ success: true })
  const otherChannel = channelRuns.enter(context("other-channel", "leo", "channel-2-leo"))
  const direct = channelRuns.enter(context("direct", "leo", "dm"))
  expect(await channelRuns.enter(context("independent", "bia-bot", "channel-bia"))).toEqual({ success: true })
  expect(channelRuns.needsYou("first", "login")).toBe(true)
  publishRunStatus("first", "succeeded")
  expect(channelRuns.get("first")?.status).toBe("needs_you")
  expect(channelRuns.get("other-channel")).toMatchObject({ status: "queued", queuePosition: 1 })
  expect(channelRuns.get("direct")).toMatchObject({ status: "queued", queuePosition: 2 })
  channelRuns.takeControl({ runId: "first", actorPersonId: "ana" })
  channelRuns.returnControl({ runId: "first", actorPersonId: "ana" })
  addRun({ runId: "resumed", botId: "leo", threadId: "channel-leo" })
  database.exec("INSERT INTO browser_takeover_continuations VALUES ('resumed','first','first',2)")
  expect(await channelRuns.enter(context("resumed", "leo", "channel-leo"))).toEqual({ success: true })
  expect(channelRuns.list().filter((run) => run.runId === "first")).toHaveLength(1)
  publishRunStatus("resumed", "succeeded")
  expect(await otherChannel).toEqual({ success: true, queued: true })
  publishRunStatus("other-channel", "canceled")
  expect(await direct).toEqual({ success: true, queued: true })
  expect(channelRuns.get("independent")?.status).toBe("running")
})

test("canceling a waiting request preserves the active human controller", async () => {
  const fixture = createFixture()
  const { database, kernel, addRun, publishRunStatus, context } = fixture
  const channelRuns = createChannelBrowserRuns({ kernel, database })
  additionalCleanups.add(() => {
    channelRuns.dispose()
    fixture.cleanup()
  })
  addRun({ runId: "held", botId: "leo", threadId: "channel-leo" })
  addRun({ runId: "waiting", botId: "leo", threadId: "channel-2-leo" })
  await channelRuns.enter(context("held", "leo", "channel-leo"))
  channelRuns.takeControl({ runId: "held", actorPersonId: "ana" })
  await channelRuns.enter(context("waiting", "leo", "channel-2-leo"))

  expect(channelRuns.cancelRequest("waiting")).toMatchObject({ runId: "waiting", ownsControl: false })
  publishRunStatus("waiting", "canceled")

  expect(channelRuns.get("held")).toMatchObject({ status: "taken_over", controllerPersonId: "ana" })
  expect(fixture.resumptions).toHaveLength(0)
})

test("promotion survives restart and old completion cannot finish the continuation", async () => {
  const fixture = createFixture()
  const { database, kernel, addRun, publishRunStatus, context } = fixture
  const first = createChannelBrowserRuns({ kernel, database })
  addRun({ runId: "active", botId: "leo", threadId: "channel-leo" })
  addRun({ runId: "next", botId: "leo", threadId: "channel-2-leo" })
  await first.enter(context("active", "leo", "channel-leo"))
  await first.enter(context("next", "leo", "channel-2-leo"))
  publishRunStatus("next", "succeeded")
  publishRunStatus("active", "succeeded")
  first.dispose()
  const restored = createChannelBrowserRuns({ kernel, database })
  additionalCleanups.add(() => {
    restored.dispose()
    fixture.cleanup()
  })

  expect(fixture.resumptions.map((run) => run.runId)).toEqual(["next", "next"])
  publishRunStatus("next", "succeeded")
  expect(restored.get("next")?.status).toBe("running")
  addRun({ runId: "continued", botId: "leo", threadId: "channel-2-leo" })
  database.exec("INSERT INTO browser_takeover_continuations VALUES ('continued','next','next',2)")
  publishRunStatus("continued", "succeeded")

  expect(restored.get("next")?.status).toBe("succeeded")
})

test("failed control startup restores the human wait without starting a continuation", async () => {
  const fixture = createFixture()
  const channelRuns = createChannelBrowserRuns({ kernel: fixture.kernel, database: fixture.database })
  additionalCleanups.add(() => {
    channelRuns.dispose()
    fixture.cleanup()
  })
  fixture.addRun({ runId: "login", botId: "leo", threadId: "channel-leo" })
  await channelRuns.enter(fixture.context("login", "leo", "channel-leo"))
  channelRuns.needsYou("login", "login")
  channelRuns.takeControl({ runId: "login", actorPersonId: "ana" })

  channelRuns.restoreControl({ runId: "login", actorPersonId: "ana", status: "needs_you" })

  expect(channelRuns.get("login")).toMatchObject({ status: "needs_you", controllerPersonId: null })
  expect(fixture.resumptions).toHaveLength(0)
})
