import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserEngine } from "../../src/browser/engine"
import type { CdpClient, JsonObject } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getFixture = async ({
  existingTarget = true,
  localBrowser = true,
  capture = async (_params: JsonObject): Promise<JsonObject> => ({ data: "ZmFrZQ==" }),
  attach = async (): Promise<JsonObject> => ({ sessionId: "owned-session" }),
  onDetach = (_sessionId: string): void => {},
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "touri-takeover-readiness-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Lia','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO browser_tabs(id,owner_bot_id,owner_thread_id,cdp_target_id,url,state,private_after_takeover,created_at,last_used_at)
      VALUES ('tab','bot','thread','owned','https://example.test/public','live',1,1,1);
  `)
  const calls: Array<{ method: string; params: JsonObject }> = []
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      calls.push({ method, params })
      if (method === "Target.getTargetInfo") {
        if (!existingTarget) throw new Error("Target missing")
        return {
          targetInfo: { targetId: "owned", type: "page", url: "https://example.test/private", title: "Private" },
        } as T
      }
      if (method === "Target.attachToTarget") return (await attach()) as T
      if (method === "Target.detachFromTarget") onDetach(String(params.sessionId))
      if (method === "Page.captureScreenshot") return (await capture(params)) as T
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } } as T
      return {} as T
    },
    subscribe: () => () => {},
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    localBrowser,
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  runtime.kernel.services.provide("runtime.canReturnBrowserTakeover", ({ personId }) => personId === "authorized")
  cleanups.add(async () => {
    await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })

  return { engine, calls }
}

const requestTakeover = (engine: ReturnType<typeof createBrowserEngine>) =>
  engine.requestTakeover({
    tabId: "tab",
    botId: "bot",
    reason: "Synthetic request",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    notify: false,
  })

test("a persisted unloaded tab recovers its exact existing target before granting interactive control", async () => {
  const { engine, calls } = await getFixture()
  expect(engine.tabsForBot("bot")[0]?.state).toBe("unloaded")
  await requestTakeover(engine)

  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("held")
  const frame = await engine.takeoverFrame({ tabId: "tab", botId: "bot", signal: new AbortController().signal })

  expect(frame?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")
  expect(engine.tabsForBot("bot")[0]).toMatchObject({ state: "live", url: "", title: "" })
  expect(calls.find((call) => call.method === "Target.attachToTarget")?.params.targetId).toBe("owned")
  expect(calls.some((call) => ["Target.createTarget", "Page.navigate", "Page.reload"].includes(call.method))).toBe(
    false,
  )
  expect(await engine.takeoverFrame({ tabId: "tab", botId: "other", signal: new AbortController().signal })).toBeNull()
})

test.each([true, false])(
  "unrecoverable persisted tab fails safely without navigation (local=%s)",
  async (localBrowser) => {
    const { engine, calls } = await getFixture({ existingTarget: false, localBrowser })
    await requestTakeover(engine)

    expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("not_found")

    expect(engine.tabsForBot("bot")[0]?.state).toBe("unloaded")
    expect(
      calls.some((call) => ["Target.createTarget", "Target.attachToTarget", "Page.navigate"].includes(call.method)),
    ).toBe(false)
  },
)

test("unauthorized people cannot reconnect a persisted page", async () => {
  const { engine, calls } = await getFixture()
  await requestTakeover(engine)

  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "stranger" })).toBe("forbidden")

  expect(
    calls.some((call) =>
      ["Target.getTargetInfo", "Target.attachToTarget", "Page.captureScreenshot"].includes(call.method),
    ),
  ).toBe(false)
})

test.each(["abort", "return"] as const)("%s cancels pending recovery without granting late control", async (action) => {
  const started = Promise.withResolvers<void>()
  const frame = Promise.withResolvers<JsonObject>()
  const { engine } = await getFixture({
    capture: () => {
      started.resolve()
      return frame.promise
    },
  })
  await requestTakeover(engine)
  const controller = new AbortController()
  const pending = engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized", signal: controller.signal })
  await started.promise

  if (action === "abort") controller.abort()
  else await engine.releaseTakeover("tab")
  expect(await pending).toBe("not_found")
  frame.resolve({ data: "ZmFrZQ==" })

  if (action === "return") expect(engine.tabsForBot("bot")[0]?.heldByUser).toBe(false)
})

test("canceling an attach detaches its late session without publishing it live", async () => {
  const started = Promise.withResolvers<void>()
  const attachment = Promise.withResolvers<JsonObject>()
  const detached = Promise.withResolvers<string>()
  const { engine, calls } = await getFixture({
    attach: () => {
      started.resolve()
      return attachment.promise
    },
    onDetach: (sessionId) => detached.resolve(sessionId),
  })
  await requestTakeover(engine)
  const controller = new AbortController()
  const pending = engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized", signal: controller.signal })
  await started.promise

  controller.abort()
  expect(await pending).toBe("not_found")
  attachment.resolve({ sessionId: "late-session" })

  expect(await detached.promise).toBe("late-session")
  expect(engine.tabsForBot("bot")[0]?.state).toBe("unloaded")
  expect(calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false)
})

test("an existing live session grants control without waiting on another screenshot or disconnecting it", async () => {
  let captures = 0
  const slowFrame = Promise.withResolvers<JsonObject>()
  const started = Promise.withResolvers<void>()
  const { engine, calls } = await getFixture({
    capture: async () => {
      captures += 1
      if (captures === 1) return { data: "ZmFrZQ==" }
      started.resolve()
      return slowFrame.promise
    },
  })
  await requestTakeover(engine)
  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("held")
  const frame = engine.takeoverFrame({ tabId: "tab", botId: "bot", signal: new AbortController().signal })
  await started.promise

  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("held")
  slowFrame.resolve({ data: "ZmFrZQ==" })

  expect(await frame).not.toBeNull()
  expect(captures).toBe(2)
  expect(calls.some((call) => call.method === "Target.detachFromTarget")).toBe(false)
})

test("readiness uses the same bounded viewport scales as interactive frames", async () => {
  const { engine, calls } = await getFixture({
    capture: async (params) => {
      const clip = params.clip as JsonObject | undefined
      return { data: clip?.scale === 0.65 ? "x".repeat(450_001) : "ZmFrZQ==" }
    },
  })
  await requestTakeover(engine)

  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("held")

  const captures = calls.filter((call) => call.method === "Page.captureScreenshot")
  expect(captures.map((call) => (call.params.clip as JsonObject).scale)).toEqual([0.65, 0.5])
  expect(captures.every((call) => call.params.quality === 50 && call.params.captureBeyondViewport === false)).toBe(true)
})
