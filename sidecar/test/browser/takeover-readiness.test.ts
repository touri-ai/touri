import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserEngine } from "../../src/browser/engine"
import type { CdpClient, CdpEvent, JsonObject } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const getFixture = async ({
  existingTarget = true,
  getPrivacy = () => ({ documentId: 1, url: "https://example.test/public", title: "Public", hasSensitiveEntry: false }),
  localBrowser = true,
  capture = async (_params: JsonObject): Promise<JsonObject> => ({ data: "ZmFrZQ==" }),
  resize = async (): Promise<void> => {},
  attach = async (): Promise<JsonObject> => ({ sessionId: "owned-session" }),
  onDetach = (_sessionId: string): void => {},
  screencastData = "",
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
  let onEvent = (_event: CdpEvent): void => {}
  let onDisconnect = (): void => {}
  let closed = false
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      calls.push({ method, params })
      if (method === "Target.getTargetInfo") {
        if (!existingTarget) throw new Error("Target missing")
        return {
          targetInfo: { targetId: "owned", type: "page", url: "https://example.test/private", title: "Private" },
        } as T
      }
      if (method === "DOM.getDocument") return { root: { backendNodeId: getPrivacy().documentId } } as T
      if (method === "Runtime.evaluate" && String(params.expression).includes("hasSensitiveEntry"))
        return { result: { value: getPrivacy() } } as T
      if (method === "Target.attachToTarget") return (await attach()) as T
      if (method === "Target.detachFromTarget") onDetach(String(params.sessionId))
      if (method === "Page.captureScreenshot") return (await capture(params)) as T
      if (method === "Page.startScreencast" && screencastData)
        onEvent({
          method: "Page.screencastFrame",
          sessionId: "owned-session",
          params: { sessionId: 1, data: screencastData },
        })
      if (method === "Emulation.setDeviceMetricsOverride") await resize()
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } } as T
      return {} as T
    },
    subscribe: (listener) => {
      onEvent = listener
      return () => {}
    },
    close: async () => {
      closed = true
    },
    isClosed: () => closed,
    onDisconnect: (listener) => {
      onDisconnect = listener
      return () => {}
    },
  }
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    localBrowser,
    launcher: {
      start: async () => {
        closed = false
        return { client }
      },
      stop: async () => {},
    },
  })
  runtime.kernel.services.provide("runtime.canReturnBrowserTakeover", ({ personId }) => personId === "authorized")
  cleanups.add(async () => {
    await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })

  return {
    engine,
    calls,
    emit: (event: CdpEvent) => onEvent(event),
    disconnect: () => {
      closed = true
      onDisconnect()
    },
  }
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
      return { data: clip?.scale === 1 ? "x".repeat(450_001) : "ZmFrZQ==" }
    },
  })
  await requestTakeover(engine)

  expect(await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })).toBe("held")

  const captures = calls.filter((call) => call.method === "Page.captureScreenshot")
  expect(captures.map((call) => (call.params.clip as JsonObject).scale)).toEqual([1, 0.8])
  expect(captures.every((call) => call.params.quality === 60 && call.params.captureBeyondViewport === false)).toBe(true)
})

test("preview alone restores a new safe document after handback while the private document stays hidden", async () => {
  let documentId = 1
  const { engine } = await getFixture({
    getPrivacy: () => ({ documentId, url: "https://example.test/public", title: "Public", hasSensitiveEntry: false }),
  })
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  await engine.releaseTakeover("tab")
  const input = { botId: "bot", tabId: "tab", signal: new AbortController().signal }

  expect(await engine.preview(input)).toBeNull()
  documentId = 2
  const preview = await engine.preview(input)

  expect(preview?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")
})

test("takeover resizes the remote viewport before capturing and restores it at handback", async () => {
  const { engine, calls } = await getFixture()
  await requestTakeover(engine)
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  const input = {
    botId: "bot",
    tabId: "tab",
    signal: new AbortController().signal,
    viewport: { width: 390, height: 650 },
  }

  await engine.takeoverFrame(input)
  await engine.takeoverFrame(input)
  await engine.releaseTakeover("tab")

  const resize = calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride")
  expect(resize).toHaveLength(1)
  expect(resize[0]?.params).toEqual({ width: 390, height: 650, mobile: false, deviceScaleFactor: 0 })
  expect(calls.some((call) => call.method === "Emulation.clearDeviceMetricsOverride")).toBe(true)
})

test.each(["after", "during"])("handback restores a canceled resize when returning %s completion", async (timing) => {
  const started = Promise.withResolvers<void>()
  const resized = Promise.withResolvers<void>()
  const { engine, calls } = await getFixture({
    resize: () => {
      started.resolve()
      return resized.promise
    },
  })
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  const controller = new AbortController()
  const frame = engine.takeoverFrame({
    botId: "bot",
    tabId: "tab",
    signal: controller.signal,
    viewport: { width: 390, height: 650 },
  })
  await started.promise

  controller.abort()
  const handback = timing === "during" ? engine.releaseTakeover("tab") : null
  resized.resolve()
  expect(await frame).toBeNull()
  await (handback ?? engine.releaseTakeover("tab"))

  expect(calls.filter((call) => call.method === "Emulation.clearDeviceMetricsOverride")).toHaveLength(1)
})

test("unknown private documents recover only after a committed replacement following handback", async () => {
  let documentId = 0
  const { engine, emit } = await getFixture({
    getPrivacy: () => ({ documentId, url: "https://example.test/public", title: "Public", hasSensitiveEntry: false }),
  })
  await requestTakeover(engine)
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  await engine.releaseTakeover("tab")
  const input = { botId: "bot", tabId: "tab", signal: new AbortController().signal }

  expect(await engine.preview(input)).toBeNull()
  documentId = 2
  emit({
    method: "Page.navigatedWithinDocument",
    sessionId: "owned-session",
    params: {
      frameId: "owned",
      url: "https://example.test/public#results",
    },
  })
  expect(await engine.preview(input)).toBeNull()
  emit({
    method: "Page.frameNavigated",
    sessionId: "owned-session",
    params: {
      frame: { id: "main", url: "https://example.test/public" },
      type: "BackForwardCacheRestore",
    },
  })
  expect(await engine.preview(input)).toBeNull()
  emit({
    method: "Page.frameNavigated",
    sessionId: "owned-session",
    params: {
      frame: { id: "main", url: "https://example.test/public" },
      type: "Navigation",
    },
  })
  const preview = await engine.preview(input)

  expect(preview?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")

  documentId = 1
  emit({
    method: "Page.frameNavigated",
    sessionId: "owned-session",
    params: {
      frame: { id: "main", url: "https://example.test/public" },
      type: "BackForwardCacheRestore",
    },
  })
  expect(await engine.preview(input)).toBeNull()

  documentId = 2
  emit({
    method: "Page.frameNavigated",
    sessionId: "owned-session",
    params: {
      frame: { id: "main", url: "https://example.test/public" },
      type: "BackForwardCacheRestore",
    },
  })
  expect((await engine.preview(input))?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")
})

test("the same phone viewport is applied again after the controller reconnects to a new CDP session", async () => {
  let attachments = 0
  const { engine, calls, disconnect } = await getFixture({
    attach: async () => {
      attachments += 1
      return { sessionId: `owned-session-${attachments}` }
    },
  })
  const input = {
    tabId: "tab",
    botId: "bot",
    signal: new AbortController().signal,
    viewport: { width: 390, height: 650 },
  }
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  await engine.takeoverFrame(input)

  disconnect()
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  await engine.takeoverFrame(input)

  expect(attachments).toBe(2)
  expect(calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride")).toHaveLength(2)
})

test("human navigation rejects non-web schemes and pointer coordinates outside the observed view", async () => {
  const { engine, calls } = await getFixture()
  await requestTakeover(engine)
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  const frame = await engine.takeoverFrame({ tabId: "tab", botId: "bot", signal: new AbortController().signal })
  if (!frame) throw new Error("Synthetic frame missing")
  const observed = {
    tabId: "tab",
    botId: "bot",
    targetEpoch: frame.targetEpoch,
    width: frame.width,
    height: frame.height,
    signal: new AbortController().signal,
  }

  const navigation = await engine.takeoverInput({
    ...observed,
    input: { kind: "navigate", action: "goto", url: "file:///workspace/private" },
  })
  const pointer = await engine.takeoverInput({
    ...observed,
    input: { kind: "pointer", phase: "down", x: 2, y: 0.5, button: "left" },
  })

  expect(navigation).toBe(false)
  expect(pointer).toBe(false)
  expect(calls.some((call) => call.method === "Page.navigate" || call.method === "Input.dispatchMouseEvent")).toBe(
    false,
  )
})

test("oversized live images retain interactive screenshot fallback without restarting capture", async () => {
  const { engine, calls } = await getFixture({ screencastData: "x".repeat(450_001) })
  await requestTakeover(engine)
  await engine.holdTakeoverForPerson({ tabId: "tab", personId: "authorized" })
  const request = { tabId: "tab", botId: "bot", signal: new AbortController().signal, stream: true }

  const first = await engine.takeoverFrame(request)
  const second = await engine.takeoverFrame(request)

  expect(first?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")
  expect(second?.image).toBe(first?.image)
  expect(first?.width).toBe(800)
  expect(first?.height).toBe(500)
  expect(calls.filter((call) => call.method === "Page.startScreencast")).toHaveLength(1)
  expect(calls.some((call) => call.method === "Page.stopScreencast")).toBe(true)
})
