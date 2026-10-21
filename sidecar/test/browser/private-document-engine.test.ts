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

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-browser-private-document-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('leo','Léo','codex','/workspace',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','leo','Synthetic',1,1);
  `)
  database
    .query(`INSERT INTO browser_tabs(id,profile,owner_bot_id,owner_thread_id,cdp_target_id,url,state,created_at,last_used_at)
    VALUES ('tab','default','leo','thread','owned','https://example.test/results','live',1,?)`)
    .run(Date.now())
  let documentId = 1
  let captures = 0
  const listeners = new Set<(event: CdpEvent) => void>()
  const getPage = () => ({
    url: "https://example.test/results",
    href: "https://example.test/results",
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
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      if (method === "Target.getTargets")
        return {
          targetInfos: [{ targetId: "owned", type: "page", title: "Results", url: "https://example.test/results" }],
        } as T
      if (method === "Target.attachToTarget") return { sessionId: "session" } as T
      if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: documentId } } as T
      if (method === "Accessibility.getFullAXTree") return { nodes: [] } as T
      if (method === "DOM.querySelectorAll") return { nodeIds: [] } as T
      if (method === "Page.getLayoutMetrics")
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } } as T
      if (method === "Page.captureScreenshot") {
        captures += 1
        return { data: "ZmFrZQ==" } as T
      }
      if (method === "Runtime.evaluate") {
        const metadata = String(params.expression).includes("hasSensitiveEntry:")
        return {
          result: {
            value: metadata
              ? { url: "https://example.test/results", title: "Results", hasSensitiveEntry: false, documentId: 999 }
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
  }
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    localBrowser: true,
    discoverBotId: "leo",
    launcher: { start: async () => ({ client }), stop: async () => {} },
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

  return { engine, navigate, captures: () => captures }
}

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
