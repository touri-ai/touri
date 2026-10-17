import { afterEach, expect, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, ToolContext } from "@touri/contracts"
import { createBrowserEngine } from "../../src/browser/engine"
import { attachLocalChrome } from "../../src/browser/launcher"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-local-chrome-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
type Call = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
const chrome = () => {
  const calls: Call[] = []
  const requests: URL[] = []
  const pages = new Map([
    ["user-tab", { targetId: "user-tab", type: "page", title: "Personal", url: "https://personal.test/" }],
    ["user-settings", { targetId: "user-settings", type: "page", title: "Settings", url: "chrome://settings/" }],
  ])
  let next = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      requests.push(new URL(request.url))
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 })
    },
    websocket: {
      message: (socket, raw) => {
        const call = JSON.parse(String(raw)) as Call
        calls.push(call)
        let result: unknown = {}
        if (call.method === "Target.setDiscoverTargets") {
          for (const targetInfo of pages.values()) {
            socket.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo } }))
            // An unsolicited event for a user's popup must not trigger URL enforcement.
            socket.send(
              JSON.stringify({
                method: "Target.attachedToTarget",
                params: {
                  sessionId: `unsolicited-${targetInfo.targetId}`,
                  targetInfo: { ...targetInfo, openerId: "user-tab" },
                },
              }),
            )
          }
        }
        if (call.method === "Target.createTarget") {
          const targetId = `bot-${++next}`
          pages.set(targetId, { targetId, type: "page", title: "Bot page", url: String(call.params.url) })
          result = { targetId }
        }
        if (call.method === "Target.getTargets") result = { targetInfos: [...pages.values()] }
        if (call.method === "Target.getTargetInfo") {
          const targetInfo = pages.get(String(call.params.targetId))
          if (!targetInfo) {
            socket.send(JSON.stringify({ id: call.id, error: { message: "No target with given id" } }))
            return
          }
          result = { targetInfo }
        }
        if (call.method === "Target.attachToTarget") result = { sessionId: `session-${call.params.targetId}` }
        if (call.method === "Target.closeTarget") {
          const targetId = String(call.params.targetId)
          pages.delete(targetId)
          result = { success: true }
          socket.send(JSON.stringify({ method: "Target.targetDestroyed", params: { targetId } }))
        }
        if (call.method === "Runtime.evaluate") {
          const page = pages.get(call.sessionId?.replace("session-", "") ?? "")
          result = {
            result: {
              value: {
                url: page?.url ?? "about:blank",
                href: page?.url ?? "about:blank",
                title: page?.title ?? "",
                loading: false,
                readyState: "complete",
                text: "Bot content",
                frames: [],
                challengeElements: [],
                viewport: { width: 1280, height: 860, scrollY: 0, scrollHeight: 860 },
                active: { role: "", name: "", backendNodeId: null },
                mutationVersion: 0,
                hasCanvas: false,
                hasVideo: false,
                crossOriginIframe: false,
              },
            },
          }
        }
        if (call.method === "Accessibility.getFullAXTree") result = { nodes: [] }
        socket.send(JSON.stringify({ id: call.id, result }))
      },
    },
  })
  cleanups.push(() => server.stop(true))
  const dataDir = directory()
  writeFileSync(join(dataDir, "DevToolsActivePort"), `${server.port}\n/devtools/browser/consented-chrome\n`)
  return { calls, requests, pages, server, dataDir }
}
const fixture = async (routed = false) => {
  const fake = chrome()
  const runtime = createKernel({ appData: directory() })
  await initStore(runtime.kernel)
  const headers = { Authorization: "Bearer dev-ui-token", "x-touri-client": "local-chrome-test" }
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Local", provider: "codex", browser: "local" }),
  })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }
  const launcher = attachLocalChrome({ dataDir: fake.dataDir })
  let spawns = 0
  const kernel = {
    ...runtime.kernel,
    spawnTree: () => {
      spawns++
      throw new Error("Local Chrome must never spawn")
    },
  }
  const engine = routed
    ? createRoutedBrowserEngine(kernel, "system-chrome", { localLauncher: launcher })
    : createBrowserEngine({ kernel, launcher, profile: "local", localBrowser: true })
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    runId: null,
    projectId: null,
    cwd: runtime.kernel.paths.appData,
    signal: new AbortController().signal,
  }
  cleanups.push(async () => {
    await engine.shutdown()
    runtime.stop()
  })
  return { ...fake, engine, ctx, bot, runtime, spawns: () => spawns }
}

test("local launcher reads DevToolsActivePort, connects only to loopback, never spawns and only disconnects on stop", async () => {
  const fake = chrome()
  const launcher = attachLocalChrome({ dataDir: fake.dataDir })
  const bunSpawn = spyOn(Bun, "spawn")
  const nodeSpawn = spyOn(childProcess, "spawn")
  try {
    const started = await launcher.start()
    expect(started).not.toBeNull()
    expect(await launcher.start()).toEqual(started)
    await launcher.stop()
    await launcher.stop()
    expect(started?.client.isClosed()).toBe(true)
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.hostname).toBe("127.0.0.1")
    expect(fake.requests[0]?.pathname).toBe("/devtools/browser/consented-chrome")
    expect(fake.calls.map((call) => call.method)).toEqual(["Browser.getVersion"])
    expect(fake.pages.has("user-tab")).toBe(true)
    expect(bunSpawn).not.toHaveBeenCalled()
    expect(nodeSpawn).not.toHaveBeenCalled()
  } finally {
    bunSpawn.mockRestore()
    nodeSpawn.mockRestore()
    await launcher.stop()
  }
})

test("missing DevToolsActivePort returns LOCAL_BROWSER_UNAVAILABLE with all consent steps", async () => {
  const launcher = attachLocalChrome({ dataDir: directory() })
  await expect(launcher.start()).rejects.toMatchObject({
    errorCode: "LOCAL_BROWSER_UNAVAILABLE",
    message: expect.stringContaining("chrome://inspect/#remote-debugging"),
  })
  await expect(launcher.start()).rejects.toThrow("permita a depuração remota e aceite o pedido de permissão")
  await launcher.stop()
})

test.each([
  "https://remote.test/devtools/browser/id",
  "//remote.test/id",
  "/devtools/browser/id?host=remote",
  "/devtools/browser/../id",
  "\n/devtools/browser/id",
])("invalid endpoint never makes a connection: %s", async (path) => {
  const dataDir = directory()
  writeFileSync(join(dataDir, "DevToolsActivePort"), `9222\n${path}\n`)
  const websocket = spyOn(globalThis, "WebSocket")
  try {
    await expect(attachLocalChrome({ dataDir }).start()).rejects.toMatchObject({
      errorCode: "LOCAL_BROWSER_UNAVAILABLE",
    })
    expect(websocket).not.toHaveBeenCalled()
  } finally {
    websocket.mockRestore()
  }
})

test("stale or refused CDP fails without fallback", async () => {
  const fake = chrome()
  fake.server.stop(true)
  await expect(attachLocalChrome({ dataDir: fake.dataDir, timeoutMs: 100 }).start()).rejects.toMatchObject({
    errorCode: "LOCAL_BROWSER_UNAVAILABLE",
  })
})

test.each([false, true])(
  "local bot uses a new default-context window and never lists, reads or closes personal tabs (routed=%s)",
  async (routed) => {
    const f = await fixture(routed)
    expect((await f.engine.open({ url: "https://bot.test/", ctx: f.ctx, timeoutMs: 1500 })).success).toBe(true)
    const tabId = f.engine.tabsForBot(f.bot.id)[0]?.tabId ?? ""
    expect(f.calls.find((call) => call.method === "Target.createTarget")?.params).toEqual({
      url: "https://bot.test/",
      background: false,
      newWindow: true,
    })
    expect(await f.engine.list({ botId: f.bot.id })).toMatchObject({
      success: true,
      structured: { tabs: [expect.objectContaining({ tabId, title: "Bot page" })] },
    })
    expect(f.engine.tabsForBot(null).map((tab) => tab.title)).toEqual(["Bot page"])
    expect(
      await f.engine.snapshot({ tabId, botId: "another-bot", image: "never", signal: f.ctx.signal }),
    ).toMatchObject({ errorCode: routed ? "TAB_NOT_FOUND" : "TAB_NOT_OWNED" })
    expect(await f.engine.close({ tabId: "user-tab", botId: f.bot.id, signal: f.ctx.signal })).toMatchObject({
      errorCode: "TAB_NOT_FOUND",
    })
    expect(
      f.calls.filter((call) => call.method === "Target.attachToTarget").map((call) => call.params.targetId),
    ).toEqual(["bot-1"])
    expect(f.calls.filter((call) => call.sessionId).every((call) => call.sessionId === "session-bot-1")).toBe(true)
    expect(
      f.calls.some((call) =>
        [
          "Storage.getCookies",
          "Storage.setCookies",
          "Target.createBrowserContext",
          "Target.disposeBrowserContext",
        ].includes(call.method),
      ),
    ).toBe(false)
    expect(
      f.calls
        .filter((call) => call.method === "Target.setAutoAttach")
        .every((call) => call.sessionId === "session-bot-1"),
    ).toBe(true)
    await f.engine.shutdown()
    expect(f.calls.filter((call) => call.method === "Target.closeTarget").map((call) => call.params.targetId)).toEqual([
      "bot-1",
    ])
    expect(f.calls.some((call) => call.method === "Browser.close")).toBe(false)
    expect([...f.pages.keys()]).toEqual(["user-tab", "user-settings"])
    expect(f.spawns()).toBe(0)
  },
)

test("local idle unload closes only owned targets", async () => {
  const f = await fixture()
  expect((await f.engine.open({ url: "https://bot.test/", ctx: f.ctx, timeoutMs: 1500 })).success).toBe(true)
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000)
  try {
    expect(f.engine.tabsForBot(f.bot.id)[0]?.state).toBe("unloaded")
    await Bun.sleep(10)
    expect(f.calls.filter((call) => call.method === "Target.closeTarget").map((call) => call.params.targetId)).toEqual([
      "bot-1",
    ])
    expect(f.pages.has("user-tab")).toBe(true)
  } finally {
    clock.mockRestore()
  }
})

test("engine surfaces local launcher failure with its code instead of using the touri profile", async () => {
  const f = await fixture(true)
  rmSync(join(f.dataDir, "DevToolsActivePort"))
  expect(await f.engine.open({ url: "https://bot.test/", ctx: f.ctx, timeoutMs: 1000 })).toMatchObject({
    success: false,
    errorCode: "LOCAL_BROWSER_UNAVAILABLE",
  })
  expect(f.spawns()).toBe(0)
  expect(f.requests).toEqual([])
})
