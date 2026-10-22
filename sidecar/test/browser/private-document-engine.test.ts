import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
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
  privateInput = false,
  localBrowser = true,
  getUrl = (): string => "https://example.test/results",
  getHasSensitiveEntry = (): boolean => false,
  captureScreenshot = async () => ({ data: "ZmFrZQ==" }),
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "touri-browser-private-document-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('leo','Léo','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','leo','Synthetic',1,1);
  `)
  database
    .query(`INSERT INTO browser_tabs(id,profile,owner_bot_id,owner_thread_id,cdp_target_id,url,state,
      private_input,private_after_takeover,private_document_ids_json,created_at,last_used_at)
    VALUES ('tab','default','leo','thread','owned',?,'live',?,0,?,1,?)`)
    .run(
      privateInput ? "" : "https://example.test/results",
      privateInput ? 1 : 0,
      privateInput ? "[1]" : "[]",
      Date.now(),
    )
  let documentId = 1
  let captures = 0
  const listeners = new Set<(event: CdpEvent) => void>()
  const disconnectListeners = new Set<() => void>()
  const getPage = () => ({
    url: getUrl(),
    href: getUrl(),
    title: "Results",
    loading: false,
    readyState: "complete",
    mutationVersion: 0,
    text: [1, 3].includes(documentId) ? "private-input-fixture" : "Public results",
    frames: [],
    challengeElements: [],
    active: { role: "", name: "", backendNodeId: null },
    viewport: { width: 800, height: 500, scrollY: 0, scrollHeight: 500 },
    hasCanvas: false,
    hasVideo: false,
    crossOriginIframe: false,
  })
  const getClient = (): CdpClient => ({
    call: async <T>(method: string, params: JsonObject = {}) => {
      if (method === "Target.getTargets")
        return {
          targetInfos: [{ targetId: "owned", type: "page", title: "Results", url: getUrl() }],
        } as T
      if (method === "Target.attachToTarget") return { sessionId: "session" } as T
      if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: documentId } } as T
      if (method === "Accessibility.getFullAXTree") return { nodes: [] } as T
      if (method === "DOM.querySelectorAll") return { nodeIds: [] } as T
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } } as T
      if (method === "Page.captureScreenshot") {
        captures += 1
        return (await captureScreenshot()) as T
      }
      if (method === "Runtime.evaluate") {
        const metadata = String(params.expression).includes("hasSensitiveEntry:")
        return {
          result: {
            value: metadata
              ? { url: getUrl(), title: "Results", hasSensitiveEntry: getHasSensitiveEntry(), documentId: 999 }
              : getPage(),
          },
        } as T
      }
      return {} as T
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isClosed: () => false,
    close: async () => {},
    onDisconnect: (listener) => {
      disconnectListeners.add(listener)

      return () => {
        disconnectListeners.delete(listener)
      }
    },
  })
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    localBrowser,
    discoverBotId: "leo",
    launcher: { start: async () => ({ client: getClient() }), stop: async () => {} },
  })
  cleanups.add(async () => {
    await engine.shutdown()
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  const navigate = (id: number) => {
    documentId = id
    listeners.forEach((listener) => {
      listener({
        method: "Page.frameNavigated",
        sessionId: "session",
        params: { frame: { id: "main", url: "https://example.test/results" } },
      })
    })
  }

  const emit = (event: CdpEvent) =>
    listeners.forEach((listener) => {
      listener(event)
    })
  const disconnect = () =>
    disconnectListeners.forEach((listener) => {
      listener()
    })

  return { engine, navigate, emit, disconnect, captures: () => captures }
}

const getSameDocumentEvent = (method: string, url: string, frameId = "main"): CdpEvent => {
  if (method === "Page.navigatedWithinDocument")
    return {
      method,
      sessionId: "session",
      params: { frameId, url, navigationType: url.includes("#") ? "fragment" : "historyApi" },
    }

  return { method, sessionId: "session", params: { frame: { id: frameId, url }, type: "SameDocument" } }
}

test("restored private-input tabs require fresh verification before shared previews resume", async () => {
  const fixture = await getFixture({ privateInput: true })
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })

  const restored = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(restored).toBeNull()
  expect(fixture.captures()).toBe(0)

  fixture.navigate(2)

  const safePage = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
  const preview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(safePage).toMatchObject({ success: true, structured: { text: "Public results", image: null } })
  expect(preview).toEqual({ title: "", url: "", image: "data:image/jpeg;base64,ZmFrZQ==" })
  expect(fixture.captures()).toBe(1)
})

test("reconnecting retained private-input tabs requires fresh sensitive-entry verification", async () => {
  const getHasSensitiveEntry = mock(() => false)
  const fixture = await getFixture({ getHasSensitiveEntry })
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic handoff" })
  await fixture.engine.releaseTakeover("tab")
  fixture.navigate(2)
  await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "never", signal })
  const initial = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(initial?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")

  getHasSensitiveEntry.mockReturnValue(true)
  fixture.disconnect()
  await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "never", signal })
  const privatePreview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(privatePreview).toBeNull()
  expect(fixture.captures()).toBe(1)

  getHasSensitiveEntry.mockReturnValue(false)
  await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "never", signal })
  const recovered = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(recovered).toEqual({ title: "", url: "", image: "data:image/jpeg;base64,ZmFrZQ==" })
  expect(fixture.captures()).toBe(2)
})

test.each([
  { localBrowser: false, method: "Page.navigatedWithinDocument", path: "/login" },
  { localBrowser: false, method: "Page.frameNavigated", path: "/payment" },
  { localBrowser: true, method: "Page.navigatedWithinDocument", path: "/#/login" },
  { localBrowser: true, method: "Page.frameNavigated", path: "/#/payment" },
  { localBrowser: false, method: "Page.navigatedWithinDocument", path: "/%6cogin" },
])("same-document route %p reapplies privacy after safe-document clearance", async ({ localBrowser, method, path }) => {
  // The mock supplies changing CDP location state without mutating page fixtures.
  const getUrl = mock(() => "https://example.test/results")
  const fixture = await getFixture({ localBrowser, getUrl })
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic handoff" })
  await fixture.engine.releaseTakeover("tab")
  fixture.navigate(2)
  const safePage = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
  const initial = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(safePage).toMatchObject({ success: true, structured: { text: "Public results", image: null } })
  expect(initial).toEqual({ title: "", url: "", image: "data:image/jpeg;base64,ZmFrZQ==" })

  getUrl.mockReturnValue(`https://example.test${path}`)
  fixture.emit(getSameDocumentEvent(method, getUrl()))
  const preview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })
  const sensitivePage = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })

  expect(preview).toBeNull()
  expect(sensitivePage).toMatchObject({ success: true, structured: { title: "", url: "", text: "", image: null } })
  expect(await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })).toBeNull()
  expect(fixture.captures()).toBe(1)

  getUrl.mockReturnValue("https://example.test/results?next=/login")
  fixture.emit(getSameDocumentEvent(method, getUrl()))
  const recovered = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
  const recoveredPreview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(recovered).toMatchObject({
    success: true,
    structured: { title: "", url: "", text: "Public results", image: null },
  })
  expect(recoveredPreview).toEqual({ title: "", url: "", image: "data:image/jpeg;base64,ZmFrZQ==" })
  expect(fixture.captures()).toBe(2)
})

test.each(["Page.navigatedWithinDocument", "Page.frameNavigated"])(
  "%s invalidates a cached preview for an ordinary query route",
  async (method) => {
    const fixture = await getFixture()
    const signal = new AbortController().signal
    await fixture.engine.list({ botId: "leo" })
    const initial = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

    fixture.emit(getSameDocumentEvent(method, "https://example.test/results?next=/login", "owned"))
    const preview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

    expect(initial?.url).toBe("https://example.test/results")
    expect(preview?.url).toBe("https://example.test/results?next=/login")
    expect(fixture.captures()).toBe(2)
  },
)

test.each(["Page.navigatedWithinDocument", "Page.frameNavigated"])(
  "%s discards an in-flight preview without starting another capture",
  async (method) => {
    const started = Promise.withResolvers<void>()
    const capture = Promise.withResolvers<{ data: string }>()
    const fixture = await getFixture({
      captureScreenshot: () => {
        started.resolve()
        return capture.promise
      },
    })
    const signal = new AbortController().signal
    await fixture.engine.list({ botId: "leo" })
    const pending = fixture.engine.preview({ botId: "leo", tabId: "tab", signal })
    await started.promise

    fixture.emit(getSameDocumentEvent(method, "https://example.test/results?sort=price", "owned"))
    const overlapping = fixture.engine.preview({ botId: "leo", tabId: "tab", signal })
    capture.resolve({ data: "ZmFrZQ==" })
    const [overlappingFrame, stale] = await Promise.all([overlapping, pending])

    expect(overlappingFrame).toBeNull()
    expect(stale).toBeNull()
    expect(fixture.captures()).toBe(1)

    const current = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

    expect(current?.url).toBe("https://example.test/results?sort=price")
    expect(fixture.captures()).toBe(2)
  },
)

test("same-document iframe events cannot replace the main page metadata", async () => {
  const fixture = await getFixture()
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  fixture.emit(getSameDocumentEvent("Page.frameNavigated", "https://example.test/login", "owned"))

  fixture.emit(getSameDocumentEvent("Page.navigatedWithinDocument", "https://example.test/results", "child"))
  const preview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

  expect(preview).toBeNull()
  expect(fixture.captures()).toBe(0)
})

test.each(["Page.navigatedWithinDocument", "Page.frameNavigated"])(
  "%s cannot clear the original private document through a safe route",
  async (method) => {
    const fixture = await getFixture()
    const signal = new AbortController().signal
    await fixture.engine.list({ botId: "leo" })
    await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic handoff" })
    await fixture.engine.releaseTakeover("tab")

    fixture.emit(getSameDocumentEvent(method, "https://example.test/results?sort=price", "owned"))
    const snapshot = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
    const preview = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })

    expect(snapshot).toMatchObject({ success: true, structured: { title: "", url: "", text: "", image: null } })
    expect(preview).toBeNull()
    expect(fixture.captures()).toBe(0)
  },
)

test("handoff cannot reveal the original document through changed metadata or browser history", async () => {
  const fixture = await getFixture()
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  const initial = await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })
  expect(initial?.image).toBe("data:image/jpeg;base64,ZmFrZQ==")

  await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic handoff" })
  await fixture.engine.releaseTakeover("tab")
  const original = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })

  expect(JSON.stringify(original)).not.toContain("private-input-fixture")
  expect(await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })).toBeNull()
  expect(fixture.captures()).toBe(1)
  const clicked = await fixture.engine.click({
    tabId: "tab",
    botId: "leo",
    target: { kind: "role", role: "textbox", name: "Synthetic field" },
    button: "left",
    clickCount: 1,
    timeoutMs: 1000,
    signal,
  })
  expect(clicked).toMatchObject({ success: false, errorCode: "PRIVATE_TAKEOVER_ACTIVE" })
  expect(JSON.stringify(clicked)).not.toContain("private-input-fixture")

  fixture.navigate(2)
  const publicPage = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
  expect(publicPage).toMatchObject({ success: true, structured: { text: "Public results", image: null } })
  expect(await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })).not.toBeNull()
  expect(await fixture.engine.screenshot({ tabId: "tab", botId: "leo", fullPage: false, signal })).toMatchObject({
    success: false,
    errorCode: "PRIVATE_TAKEOVER_ACTIVE",
  })

  fixture.navigate(1)
  const restored = await fixture.engine.snapshot({ botId: "leo", tabId: "tab", image: "always", signal })
  expect(JSON.stringify(restored)).not.toContain("private-input-fixture")
  expect(await fixture.engine.preview({ botId: "leo", tabId: "tab", signal })).toBeNull()
  expect(fixture.captures()).toBe(2)
})

test("a document reached through native human navigation stays private after handback", async () => {
  const fixture = await getFixture()
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic native control" })

  fixture.navigate(3)
  await fixture.engine.releaseTakeover("tab")
  const page = await fixture.engine.snapshot({ tabId: "tab", botId: "leo", image: "always", signal })

  expect(JSON.stringify(page)).not.toContain("private-input-fixture")
  expect(await fixture.engine.preview({ tabId: "tab", botId: "leo", signal })).toBeNull()
})

test("waiting cannot probe text or URLs from a private document", async () => {
  const fixture = await getFixture()
  const signal = new AbortController().signal
  await fixture.engine.list({ botId: "leo" })
  await fixture.engine.holdTakeover({ tabId: "tab", reason: "Synthetic private input" })
  await fixture.engine.releaseTakeover("tab")

  const text = await fixture.engine.waitFor({
    tabId: "tab",
    botId: "leo",
    condition: { text: "private-input-fixture" },
    timeoutMs: 1000,
    signal,
  })
  const url = await fixture.engine.waitFor({
    tabId: "tab",
    botId: "leo",
    condition: { url: "example.test" },
    timeoutMs: 1000,
    signal,
  })

  expect(text).toMatchObject({ success: false, errorCode: "PRIVATE_TAKEOVER_ACTIVE" })
  expect(url).toMatchObject({ success: false, errorCode: "PRIVATE_TAKEOVER_ACTIVE" })
  expect(JSON.stringify([text, url])).not.toContain("private-input-fixture")
})
