import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import { createBrowserEngine, withDeadline } from "../../src/browser/engine"
import type { CdpClient } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

let cleanupTakeover: (() => Promise<void>) | null = null

afterEach(async () => {
  const cleanup = cleanupTakeover
  cleanupTakeover = null
  await cleanup?.()
})

test("guest browser_list_tabs discovers manually opened pages and refreshes titles without duplicates", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-guest-tabs-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "guest-tabs-test" },
    body: JSON.stringify({ name: "Guest", provider: "codex", machine: "local" }),
  })
  const { bot } = (await response.json()) as { bot: Bot }
  const botId = bot.id
  let pages = [{ targetId: "manual", type: "page", title: "Página da VM", url: "https://example.test/" }]
  const client: CdpClient = {
    call: async <T>(method: string) =>
      (method === "Target.getTargets"
        ? { targetInfos: pages }
        : method === "Target.attachToTarget"
          ? { sessionId: "manual-session" }
          : method === "Page.getLayoutMetrics"
            ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } }
            : method === "Page.captureScreenshot"
              ? { data: "ZmFrZQ==" }
              : {}) as T,
    subscribe: () => () => {},
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    profile: `vm:${botId}`,
    discoverBotId: botId,
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  const clock = spyOn(Date, "now")
  try {
    await engine.list({ botId })
    expect(engine.tabsForBot(botId)).toHaveLength(1)
    expect(engine.tabsForBot(botId)[0]).toMatchObject({
      title: "Página da VM",
      url: "https://example.test/",
      ownerBotId: botId,
    })
    pages = [{ targetId: "manual", type: "page", title: "Título atualizado", url: "https://example.test/" }]
    clock.mockReturnValue(Date.now() + 31 * 60_000)
    await engine.list({ botId })
    expect(engine.tabsForBot(botId)).toHaveLength(1)
    expect(engine.tabsForBot(botId)[0]?.title).toBe("Título atualizado")
    pages = []
    await engine.list({ botId })
    expect(engine.tabsForBot(botId)).toEqual([])
  } finally {
    clock.mockRestore()
    await engine.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("remote input is not queued behind the bot's waiting takeover request", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-guest-takeover-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "guest-takeover-test" },
    body: JSON.stringify({ name: "Guest", provider: "codex", machine: "local" }),
  })
  const { bot } = (await response.json()) as { bot: Bot }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client: CdpClient = {
    call: async <T>(method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      return (
        method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "manual", type: "page", title: "Sign in", url: "https://example.test/login" }] }
          : method === "Target.attachToTarget"
            ? { sessionId: "manual-session" }
            : method === "Page.getLayoutMetrics"
              ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } }
              : method === "Page.captureScreenshot"
                ? { data: "ZmFrZQ==" }
                : {}
      ) as T
    },
    subscribe: () => () => {},
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: runtime.kernel,
    profile: `vm:${bot.id}`,
    discoverBotId: bot.id,
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  let tabId = ""
  let takeover: Promise<unknown> | null = null
  let unsubscribe = (): void => {}
  cleanupTakeover = async () => {
    unsubscribe()
    if (tabId) await engine.releaseTakeover(tabId)
    if (takeover) await takeover
    await engine.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }

  await engine.list({ botId: bot.id })
  tabId = engine.tabsForBot(bot.id)[0]?.tabId ?? ""
  expect(tabId).not.toBe("")
  const held = new Promise<void>((resolve) => {
    unsubscribe = runtime.kernel.subscribe(({ event }) => {
      if (event.type !== "browser.tab" || event.tab.tabId !== tabId || !event.tab.heldByUser) return
      unsubscribe()
      resolve()
    })
  })
  takeover = engine.requestTakeover({
    tabId,
    botId: bot.id,
    reason: "Sign in to continue",
    timeoutMs: 20_000,
    signal: new AbortController().signal,
  })

  await held
  const frame = await engine.takeoverFrame({ tabId, botId: bot.id, signal: new AbortController().signal })
  if (!frame) throw new Error("Missing takeover frame")
  const input = await withDeadline({
    operation: (signal) =>
      engine.takeoverInput({
        tabId,
        botId: bot.id,
        targetEpoch: frame.targetEpoch,
        width: frame.width,
        height: frame.height,
        input: { kind: "text", text: "synthetic private value" },
        signal,
      }),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    onTimeout: async () => {},
  })

  expect(input).toBe(true)
  expect(calls).toContainEqual({ method: "Input.insertText", params: { text: "synthetic private value" } })
  unsubscribe()
})
