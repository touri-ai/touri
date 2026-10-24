import { afterEach, expect, test } from "bun:test"
import { createBrowserEngine } from "../../src/browser/engine"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => Promise<void>>()

afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getFixture = ({ ageMs = 31 * 60_000, privateInput = true, tabCount = 1 } = {}) => {
  const fixture = testKernel()
  const lastUsedAt = Date.now() - ageMs
  fixture.db.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
      VALUES ('sereno','Sereno QA','codex','/workspace',1,1), ('brisa','Brisa QA','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','sereno','Synthetic',1,1);
  `)
  fixture.db
    .query(`INSERT INTO browser_tabs(id,profile,owner_bot_id,owner_thread_id,url,state,
      private_input,created_at,last_used_at) VALUES ('restored','default','sereno','thread','','live',?,1,?)`)
    .run(privateInput ? 1 : 0, lastUsedAt)
  Array.from({ length: tabCount - 1 }, (_, index) => `saved-${index}`).forEach((tabId) => {
    fixture.db
      .query(`INSERT INTO browser_tabs(id,profile,owner_bot_id,url,state,created_at,last_used_at)
        VALUES (?,'default','sereno','','unloaded',1,?)`)
      .run(tabId, lastUsedAt)
  })
  const activationStarted = Promise.withResolvers<void>()
  const activation = Promise.withResolvers<void>()
  const calls: Array<{ method: string; params: JsonObject; sessionId?: string }> = []
  const listeners = new Set<(event: CdpEvent) => void>()
  let url = "about:blank"
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}, sessionId?: string) => {
      calls.push({ method, params, ...(sessionId ? { sessionId } : {}) })
      if (method === "Target.createBrowserContext") return { browserContextId: "isolated-sereno" } as T
      if (method === "Target.createTarget") return { targetId: "owned-target" } as T
      if (method === "Target.attachToTarget") return { sessionId: "owned-session" } as T
      if (method === "Runtime.enable") {
        activationStarted.resolve()
        await activation.promise
      }
      if (method === "Page.navigate") {
        url = String(params.url)
        listeners.forEach((listener) => {
          listener({
            method: "Page.frameNavigated",
            ...(sessionId ? { sessionId } : {}),
            params: { frame: { id: "main", url } },
          })
        })
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: 1 } } as T
      if (method === "Page.captureScreenshot") return { data: "ZmFrZQ==" } as T
      if (method === "Runtime.evaluate")
        return {
          result: {
            value: {
              url,
              href: url,
              title: "Synthetic public page",
              text: "Synthetic public content",
              readyState: "complete",
              loading: false,
              mutationVersion: 0,
              hasSensitiveEntry: false,
              frames: [],
              challengeElements: [],
              active: { role: "", name: "", backendNodeId: null },
              viewport: { width: 800, height: 600, scrollY: 0, scrollHeight: 600 },
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
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: fixture.kernel,
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  cleanups.add(async () => {
    activation.resolve()
    await engine.shutdown()
    fixture.close()
  })
  const navigate = (
    botId = "sereno",
    destination = "https://example.test/public",
    signal = new AbortController().signal,
  ) =>
    engine.navigate({
      tabId: "restored",
      botId,
      url: destination,
      action: "goto",
      timeoutMs: 2000,
      signal,
    })

  return { engine, calls, navigate, activationStarted, activation, lastUsedAt }
}

test.each([0, 31 * 60_000])("tab listing during restoration preserves navigation after %i ms idle", async (ageMs) => {
  const fixture = getFixture({ ageMs })
  expect(fixture.engine.tabsForBot("sereno")[0]).toMatchObject({
    tabId: "restored",
    state: "unloaded",
    lastUsedAt: fixture.lastUsedAt,
  })

  const navigation = fixture.navigate()
  await fixture.activationStarted.promise
  const duringActivation = fixture.engine.tabsForBot("sereno")
  fixture.activation.resolve()
  const result = await navigation

  expect(result).toMatchObject({ success: true, structured: { tabId: "restored" } })
  expect(duringActivation[0]?.state).toBe("live")
  expect(fixture.calls.filter((call) => call.method === "Target.closeTarget")).toEqual([])
  expect(fixture.calls.filter((call) => call.method === "Target.createTarget")).toHaveLength(1)
  expect(fixture.calls.find((call) => call.method === "Page.navigate")).toMatchObject({
    params: { url: "https://example.test/public" },
    sessionId: "owned-session",
  })
  expect(fixture.calls.find((call) => call.method === "Target.createTarget")?.params.browserContextId).toBe(
    "isolated-sereno",
  )
  expect(fixture.engine.tabsForBot("sereno")).toHaveLength(1)
})

test("restoring an owned tab at the quota does not create another saved tab or grant another bot access", async () => {
  const fixture = getFixture({ tabCount: 8 })
  expect(await fixture.navigate("brisa")).toMatchObject({ success: false, errorCode: "TAB_NOT_OWNED" })
  expect(fixture.calls).toEqual([])
  fixture.activation.resolve()

  const restored = await fixture.navigate()
  const opened = await fixture.engine.open({
    url: "https://example.test/public",
    timeoutMs: 2000,
    ctx: {
      botId: "sereno",
      threadId: "thread",
      projectId: null,
      runId: null,
      cwd: "/workspace",
      signal: new AbortController().signal,
    },
  })

  expect(restored.success).toBe(true)
  expect(opened).toMatchObject({ success: false, errorCode: "TAB_LIMIT" })
  expect(fixture.engine.tabsForBot("sereno")).toHaveLength(8)
  expect(fixture.engine.tabsForBot("brisa")).toEqual([])
})

test("restoration does not expose an unverified private document", async () => {
  const fixture = getFixture()
  fixture.activation.resolve()

  const snapshot = await fixture.engine.snapshot({
    tabId: "restored",
    botId: "sereno",
    image: "always",
    signal: new AbortController().signal,
  })
  const preview = await fixture.engine.preview({
    tabId: "restored",
    botId: "sereno",
    signal: new AbortController().signal,
  })

  expect(snapshot).toMatchObject({ success: true, structured: { url: "", title: "", text: "", image: null } })
  expect(preview).toBeNull()
  expect(fixture.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false)
})

test.each(["file:///private/synthetic", "javascript:alert(1)"])("restoration still rejects %s", async (url) => {
  const fixture = getFixture()
  fixture.activation.resolve()

  const result = await fixture.navigate("sereno", url)

  expect(result).toMatchObject({ success: false, errorCode: "URL_NOT_ALLOWED" })
  expect(fixture.calls.some((call) => call.method === "Page.navigate")).toBe(false)
})

test("canceling restoration stops the requested navigation", async () => {
  const fixture = getFixture()
  const controller = new AbortController()
  const navigation = fixture.navigate("sereno", "https://example.test/public", controller.signal)
  await fixture.activationStarted.promise

  controller.abort()
  const result = await navigation
  fixture.activation.resolve()

  expect(result.success).toBe(false)
  expect(fixture.calls.some((call) => call.method === "Page.navigate")).toBe(false)
})
