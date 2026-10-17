import { expect, spyOn, test } from "bun:test"
import type { Bot, ToolContext } from "@touri/contracts"
import { attachLocalChrome } from "../../src/browser/launcher"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixture = async (unavailable = false) => {
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

test("routed local engine opens a default-context window, reads only owned pages and shuts down without closing Chrome", async () => {
  const f = await fixture()
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
