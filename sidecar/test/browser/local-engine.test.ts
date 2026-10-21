import { afterEach, expect, spyOn, test } from "bun:test"
import type { Bot, BotGroup, BrowserTakeoverResume, Thread, ToolContext } from "@touri/contracts"
import { attachLocalChrome } from "../../src/browser/launcher"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { init as initGroups } from "../../src/groups"
import { setDelegation } from "../../src/groups/security"
import { createGroupStore } from "../../src/groups/store"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixture = async (
  unavailable = false,
  capture: () => Promise<JsonObject> = async () => ({ data: "cGFnZQ==" }),
) => {
  const f = testKernel()
  await initStore(f.kernel)
  const created = await f.request("POST /bots", { name: "Local", provider: "codex", browser: "local" })
  const { bot } = created.json as { bot: Bot }
  const calls: Array<{ method: string; params: JsonObject; sessionId?: string }> = []
  const listeners = new Set<(event: CdpEvent) => void>()
  const targets = new Set(["personal", "personal-settings"])
  let closed = false
  let next = 0
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}, sessionId?: string) => {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      if (method === "Target.setDiscoverTargets")
        for (const listener of listeners)
          listener({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "personal-session",
              targetInfo: {
                targetId: "personal-settings",
                type: "page",
                title: "Personal settings",
                url: "chrome://settings/",
                openerId: "personal",
              },
            },
          })
      if (method === "Target.createTarget") {
        const targetId = `owned-${++next}`
        targets.add(targetId)
        return { targetId } as T
      }
      if (method === "Target.attachToTarget") return { sessionId: `session-${params.targetId}` } as T
      if (method === "Target.closeTarget") targets.delete(String(params.targetId))
      if (method === "Page.captureScreenshot") return (await capture()) as T
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: {
              url: "about:blank",
              href: "about:blank",
              title: "Owned",
              readyState: "complete",
              loading: false,
              mutationVersion: 0,
              text: "Owned content",
              frames: [],
              challengeElements: [],
              active: { role: "", name: "", backendNodeId: null },
              viewport: { width: 1280, height: 860, scrollY: 0, scrollHeight: 860 },
              hasCanvas: false,
              hasVideo: false,
              crossOriginIframe: false,
            },
          },
        } as T
      return {} as T
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: async () => {
      closed = true
    },
    isClosed: () => closed,
  }
  const engine = createRoutedBrowserEngine(f.kernel, "system-chrome", {
    localLauncher: unavailable
      ? attachLocalChrome({ dataDir: f.kernel.paths.browserDir })
      : { start: async () => ({ client }), stop: () => client.close() },
  })
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    projectId: null,
    runId: null,
    cwd: f.kernel.paths.appData,
    signal: new AbortController().signal,
  }
  return { ...f, engine, bot, ctx, targets, calls, client }
}

const takeoverFixtures = new Set<Awaited<ReturnType<typeof fixture>>>()
afterEach(async () => {
  for (const resource of takeoverFixtures) {
    await resource.engine.shutdown()
    resource.close()
  }
  takeoverFixtures.clear()
})

test("routed local engine opens a default-context window, reads only owned pages and shuts down without closing Chrome", async () => {
  const capture = Promise.withResolvers<JsonObject>()
  const started = Promise.withResolvers<void>()
  const f = await fixture(false, () => {
    started.resolve()
    return capture.promise
  })
  try {
    expect((await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 1500 })).success).toBe(true)
    expect(f.calls.find((call) => call.method === "Target.createTarget")?.params).toEqual({
      url: "about:blank",
      background: false,
      newWindow: true,
    })
    expect(await f.engine.list({ botId: f.bot.id })).toMatchObject({
      success: true,
      structured: { tabs: [expect.objectContaining({ title: "Owned" })] },
    })
    const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId ?? ""
    const { bot: other } = (await f.request("POST /bots", { name: "Other", provider: "codex", browser: "local" }))
      .json as { bot: Bot }
    expect(await f.engine.snapshot({ tabId, botId: other.id, image: "never", signal: f.ctx.signal })).toMatchObject({
      errorCode: "TAB_NOT_OWNED",
    })
    expect(await f.engine.close({ tabId: "personal", botId: f.bot.id, signal: f.ctx.signal })).toMatchObject({
      errorCode: "TAB_NOT_FOUND",
    })
    expect(f.calls.filter((call) => call.sessionId).every((call) => call.sessionId === "session-owned-1")).toBe(true)
    expect(
      f.calls.filter((call) => call.method === "Target.attachToTarget").map((call) => call.params.targetId),
    ).toEqual(["owned-1"])
    expect(f.calls.some((call) => /Cookies|BrowserContext/.test(call.method))).toBe(false)
    const ownedTab = f.engine.tabsForBot(f.bot.id)[0]
    if (!ownedTab) throw new Error("Missing owned browser tab")
    const pendingPreview = f.engine.preview({ botId: f.bot.id, tabId: ownedTab.tabId, signal: f.ctx.signal })
    await started.promise
    await f.engine.holdTakeover({ tabId: ownedTab.tabId, reason: "Manual control" })
    await f.engine.releaseTakeover(ownedTab.tabId)
    capture.resolve({ data: "cGFnZQ==" })

    expect(await pendingPreview).toBeNull()
    const captures = f.calls.filter((call) => call.method === "Page.captureScreenshot").length

    expect(await f.engine.holdTakeover({ tabId: ownedTab.tabId, reason: "Manual control" })).toBe(true)
    expect(await f.engine.preview({ botId: f.bot.id, tabId: ownedTab.tabId, signal: f.ctx.signal })).toBeNull()

    expect(f.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(captures)

    expect(await f.engine.releaseTakeover(tabId)).toBe(true)
    expect(await f.engine.holdTakeover({ tabId, reason: "Synthetic second handoff" })).toBe(true)
    expect((await f.engine.close({ tabId, botId: f.bot.id, signal: f.ctx.signal })).success).toBe(true)
    await f.engine.shutdown()
    expect(f.calls.filter((call) => call.method === "Target.closeTarget").map((call) => call.params.targetId)).toEqual([
      "owned-1",
    ])
    expect(f.calls.some((call) => call.method === "Browser.close")).toBe(false)
    expect([...f.targets]).toEqual(["personal", "personal-settings"])
    expect(f.spawnTree).not.toHaveBeenCalled()
  } finally {
    await f.engine.shutdown()
    f.close()
  }
})

test.each(["idle", "quit", "switch"])("local %s closes only owned targets", async (action) => {
  const f = await fixture()
  try {
    expect((await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 1500 })).success).toBe(true)
    if (action === "idle") {
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000)
      try {
        expect(f.engine.tabsForBot(f.bot.id)[0]?.state).toBe("unloaded")
      } finally {
        clock.mockRestore()
      }
    } else if (action === "quit") f.host({ method: "app.willQuit", params: {} })
    else await f.request("PATCH /bots/:id", { browser: "touri" }, { id: f.bot.id })
    await Bun.sleep(10)
    expect([...f.targets]).toEqual(["personal", "personal-settings"])
    expect(f.calls.some((call) => call.method === "Browser.close")).toBe(false)
  } finally {
    await f.engine.shutdown()
    f.close()
  }
})

test("local attachment failures reach the tool with setup steps and never spawn an owned browser", async () => {
  const f = await fixture(true)
  try {
    expect(await f.engine.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 1000 })).toMatchObject({
      success: false,
      errorCode: "LOCAL_BROWSER_UNAVAILABLE",
      error: expect.stringContaining("chrome://inspect/#remote-debugging"),
    })
    expect(f.spawnTree).not.toHaveBeenCalled()
  } finally {
    await f.engine.shutdown()
    f.close()
  }
})

test("channel takeover notifies the channel and checks both control changes before one resume", async () => {
  const f = await fixture()
  takeoverFixtures.add(f)
  await initGroups(f.kernel)
  const response = await f.request("POST /groups", {
    name: "Equipe de viagens",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [f.bot.id],
    coordinatorBotId: null,
  })
  const { group, thread } = response.json as { group: BotGroup; thread: Thread }
  const participant = createGroupStore(f.kernel).participant(group, thread.id, f.bot.id)
  const ctx = { ...f.ctx, threadId: participant.id, runId: "handoff-run" }
  const notifications: Array<string | null> = []
  const resumed: BrowserTakeoverResume[] = []
  const delegation = {
    ceiling: { ...f.bot, access: "read-only" as const },
    caller: { id: "coordinator", name: "Planejamento" },
    groupThreadId: thread.id,
    secrets: false,
  }
  f.kernel.services.provide(
    "runtime.canReturnBrowserTakeover",
    (input) =>
      input.botId === f.bot.id &&
      input.threadId === participant.id &&
      input.runId === ctx.runId &&
      ["requester", "owner"].includes(input.personId),
  )
  f.kernel.services.provide("runtime.resumeAfterBrowserTakeover", (input) => {
    resumed.push(input)
    return true
  })
  f.kernel.services.provide("notify.emit", (input) => {
    notifications.push(input.threadId)
    return {
      ...input,
      id: 1,
      level: "info",
      botName: "Local",
      botColor: "#2563eb",
      avatarShape: "classic-none",
      requestId: input.requestId ?? null,
      createdAt: 1,
      resolvedAt: null,
      resolution: null,
    }
  })

  expect((await f.engine.open({ url: "about:blank", ctx, timeoutMs: 1500 })).success).toBe(true)
  const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId
  if (!tabId) throw new Error("Missing browser tab")
  setDelegation(f.kernel, participant.id, delegation)
  await f.engine.requestTakeover({
    tabId,
    botId: f.bot.id,
    threadId: participant.id,
    runId: ctx.runId,
    reason: "Login",
    timeoutMs: 120_000,
    signal: ctx.signal,
  })
  setDelegation(f.kernel, participant.id, null)
  const captures = f.calls.filter((call) => call.method === "Page.captureScreenshot").length
  expect(await f.engine.preview({ botId: f.bot.id, tabId, signal: ctx.signal })).toBeNull()
  expect(await f.engine.holdTakeoverForPerson({ tabId, personId: "other-member" })).toBe("forbidden")
  expect(await f.engine.holdTakeoverForPerson({ tabId, personId: "requester" })).toBe("held")
  expect(await f.engine.preview({ botId: f.bot.id, tabId, signal: ctx.signal })).toBeNull()
  expect(f.calls.filter((call) => call.method === "Page.captureScreenshot")).toHaveLength(captures)
  expect(await f.engine.releaseTakeoverForPerson({ tabId, personId: "other-member" })).toBe("forbidden")
  expect(f.engine.tabsForBot(f.bot.id)[0]?.heldByUser).toBe(true)
  expect(await f.engine.releaseTakeoverForPerson({ tabId, personId: "owner" })).toBe("released")
  expect(await f.engine.releaseTakeoverForPerson({ tabId, personId: "requester" })).toBe("released")

  expect(notifications).toEqual([thread.id])
  expect(resumed).toEqual([{ botId: f.bot.id, threadId: participant.id, runId: ctx.runId, delegation }])
})

test("a browser handback after channel deletion does not restore a stale thread reference", async () => {
  const f = await fixture()
  takeoverFixtures.add(f)
  await initGroups(f.kernel)
  const response = await f.request("POST /groups", {
    name: "Equipe de viagens",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [f.bot.id],
    coordinatorBotId: null,
  })
  const { group, thread } = response.json as { group: BotGroup; thread: Thread }
  const participant = createGroupStore(f.kernel).participant(group, thread.id, f.bot.id)
  const ctx = { ...f.ctx, threadId: participant.id }
  await f.engine.open({ url: "about:blank", ctx, timeoutMs: 1500 })
  const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId
  if (!tabId) throw new Error("Missing browser tab")
  await f.engine.requestTakeover({
    tabId,
    botId: f.bot.id,
    threadId: participant.id,
    reason: "Login",
    timeoutMs: 120_000,
    signal: ctx.signal,
  })

  const deleted = await f.request("DELETE /groups/:id", {}, { id: group.id })
  expect(deleted.status).toBe(200)
  expect(await f.engine.releaseTakeover(tabId)).toBe(true)
  const snapshot = await f.engine.snapshot({ tabId, botId: f.bot.id, image: "never", signal: ctx.signal })

  expect(snapshot.success).toBe(true)
  expect(f.db.query("SELECT owner_thread_id FROM browser_tabs WHERE id=?").get(tabId)).toEqual({
    owner_thread_id: null,
  })
})
