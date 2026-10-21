import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, MachineState, ToolContext, ToolResult, VmRuntime } from "@touri/contracts"
import type { CdpClient } from "../../src/browser/types"
import { createRoutedBrowserEngine } from "../../src/browser/vm-router"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"
import { BrowserStartError, browserStartMessage } from "../../src/vm/browser-launch"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const bounded = (work: Promise<ToolResult>) =>
  Promise.race([work, Bun.sleep(250).then(() => ({ success: false, errorCode: "STILL_WAITING" }) as ToolResult)])
const fakeCdp = (targetId: string) => {
  let closed = false
  let stuck = false
  let closes = 0
  const calls: string[] = []
  const listeners = new Set<() => void>()
  const disconnect = () => {
    closed = true
    for (const listener of [...listeners]) listener()
    listeners.clear()
  }
  const client: CdpClient = {
    call: async <T>(method: string) => {
      calls.push(method)
      if (stuck) return new Promise<T>(() => {})
      return (
        method === "Target.getTargets"
          ? { targetInfos: [{ targetId, type: "page", title: targetId, url: "https://example.test/" }] }
          : method === "Target.attachToTarget"
            ? { sessionId: `session-${targetId}` }
            : method === "Page.getLayoutMetrics"
              ? { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 500 } }
              : method === "Page.captureScreenshot"
                ? { data: "ZmFrZQ==" }
                : {}
      ) as T
    },
    subscribe: () => () => {},
    close: async () => {
      closes++
      disconnect()
    },
    isClosed: () => closed,
    onDisconnect: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    client,
    calls,
    disconnect,
    freeze: () => {
      stuck = true
    },
    closes: () => closes,
  }
}
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-hang-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  runtime.kernel.services.provide("vm.runtime", { capability: { available: true } } as VmRuntime)
  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "x-touri-client": "browser-hang-test" },
    body: JSON.stringify({ name: "Guest", provider: "codex", machine: "vm" }),
  })
  expect(response.status).toBe(201)
  const { bot } = (await response.json()) as { bot: Bot }
  let machine: MachineState = {
    botId: bot.id,
    status: "running",
    progress: null,
    error: null,
    memoryMb: 1536,
    createdMs: 1,
    startMs: 1,
  }
  let browserRunning = true
  let releases = 0
  let hostSpawns = 0
  const endpoints: Array<Parameters<VmRuntime["browserEndpoint"]>[0]> = []
  const acquisitions: Array<Parameters<VmRuntime["acquire"]>[0]> = []
  const transports: Array<ReturnType<typeof fakeCdp>> = []
  const vm = {
    states: () => [machine],
    acquire: async (input) => {
      acquisitions.push(input)
      return async () => {
        releases++
      }
    },
    browserEndpoint: async (input) => {
      endpoints.push(input)
      if (input.runningOnly && !browserRunning) return null
      browserRunning = true
      return "ws://fake/devtools/browser"
    },
  } as VmRuntime
  runtime.kernel.services.provide("vm.runtime", vm)
  const connect: typeof import("../../src/browser/cdp").connectCdpWebSocket = async () => {
    const transport = fakeCdp(`page-${transports.length + 1}`)
    transports.push(transport)
    return transport.client
  }
  const browser = createRoutedBrowserEngine(
    {
      ...runtime.kernel,
      spawnTree: () => {
        hostSpawns++
        return { success: false, errorCode: "SPAWN_FAILED", error: "host forbidden" }
      },
    },
    "system-chrome",
    { guestTimeoutMs: 40, connect },
  )
  const publish = (patch: Partial<MachineState>) => {
    machine = { ...machine, ...patch }
    runtime.kernel.publish({ type: "machine.updated", machine })
  }
  publish({})
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: bot.mainThreadId ?? "",
    projectId: null,
    runId: null,
    cwd: "/workspace",
    signal: new AbortController().signal,
  }
  cleanups.push(async () => {
    await browser.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    runtime,
    bot,
    browser,
    vm,
    ctx,
    endpoints,
    acquisitions,
    transports,
    publish,
    browserStopped: () => {
      browserRunning = false
    },
    releases: () => releases,
    hostSpawns: () => hostSpawns,
  }
}

test("a pending guest launcher cannot leave browser_list_tabs waiting forever or block later calls", async () => {
  const f = await fixture()
  const endpoint = f.vm.browserEndpoint
  const pending = deferred<string | null>()
  f.vm.browserEndpoint = () => pending.promise
  const result = await bounded(f.browser.list({ botId: f.bot.id }))
  expect(result).toMatchObject({
    success: false,
    errorCode: "DEADLINE_EXCEEDED",
    error: expect.stringContaining("O navegador da VM não respondeu"),
  })
  await Bun.sleep(1)
  expect(f.releases()).toBe(1)
  f.vm.browserEndpoint = endpoint
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  pending.resolve("ws://obsolete")
  await Bun.sleep(5)
  expect(f.transports).toHaveLength(1)
  expect(f.hostSpawns()).toBe(0)
})

for (const lifecycle of ["recreated", "restarted", "reset", "idle-stopped", "externally-started"] as const) {
  test(`cached silent stale CDP is discarded when a VM is ${lifecycle}`, async () => {
    const f = await fixture()
    await f.browser.list({ botId: f.bot.id })
    const stale = f.transports[0]
    if (!stale) throw new Error("Missing CDP fake")
    stale.freeze() // Still reports open, but its guest no longer exists.
    if (lifecycle === "idle-stopped" || lifecycle === "reset" || lifecycle === "restarted")
      f.publish({ status: "stopped", pauseReason: lifecycle === "idle-stopped" ? "inactivity" : null })
    if (lifecycle !== "externally-started") f.publish({ status: "starting" })
    f.publish({
      status: "running",
      ...(lifecycle === "externally-started"
        ? {
            connection: {
              machineId: "replacement",
              authKeyId: "new-boot",
            } as NonNullable<MachineState["connection"]>,
          }
        : {}),
    })
    expect(await bounded(f.browser.list({ botId: f.bot.id }))).toMatchObject({
      success: true,
      structured: { tabs: [expect.objectContaining({ title: "page-2" })] },
    })
    expect(stale.closes()).toBe(1)
    expect(f.transports).toHaveLength(2)
    expect(f.hostSpawns()).toBe(0)
  })
}

test("acquire can recreate the VM before the router selects its engine", async () => {
  const f = await fixture()
  await f.browser.list({ botId: f.bot.id })
  f.transports[0]?.freeze()
  const acquire = f.vm.acquire
  f.vm.acquire = async (input) => {
    f.publish({ status: "starting" })
    f.publish({ status: "running" })
    f.vm.acquire = acquire
    return acquire(input)
  }
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  expect(f.transports).toHaveLength(2)
})

test("warm running progress updates preserve the active guest client", async () => {
  const f = await fixture()
  await f.browser.list({ botId: f.bot.id })
  f.publish({ progress: "Verificando máquina…", startMs: 2 })
  await f.browser.list({ botId: f.bot.id })
  expect(f.transports).toHaveLength(1)
})

test("CDP disconnect resets the cached guest without a machine event", async () => {
  const f = await fixture()
  await f.browser.list({ botId: f.bot.id })
  f.transports[0]?.disconnect()
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  expect(f.transports).toHaveLength(2)
})

test("list on stopped VM or unopened Chromium returns empty with hint and never launches", async () => {
  const f = await fixture()
  f.publish({ status: "stopped" })
  let result = await f.browser.list({ botId: f.bot.id })
  expect(result).toMatchObject({ success: true, structured: { tabs: [] } })
  expect(JSON.stringify(result)).toContain("Navegador ainda não aberto")
  expect(f.acquisitions).toHaveLength(0)
  f.publish({ status: "running" })
  f.browserStopped()
  result = await f.browser.list({ botId: f.bot.id })
  expect(result).toMatchObject({ success: true, structured: { tabs: [] } })
  expect(JSON.stringify(result)).toContain("browser_open")
  expect(f.endpoints).toHaveLength(1)
  expect(f.endpoints[0]?.runningOnly).toBe(true)
  expect(f.acquisitions[0]?.runningOnly).toBe(true)
  expect(f.transports).toHaveLength(0)
  expect(f.hostSpawns()).toBe(0)
})

test("guest previews never acquire or launch, including with an attached browser", async () => {
  const f = await fixture()
  for (const status of ["stopped", "running"] as const) {
    f.publish({ status })
    expect(await f.browser.preview({ botId: f.bot.id, signal: f.ctx.signal })).toBeNull()
  }
  expect(f.acquisitions).toHaveLength(0)
  expect(f.endpoints).toHaveLength(0)
  expect(f.transports).toHaveLength(0)
  await f.browser.list({ botId: f.bot.id })
  const calls = [...(f.transports[0]?.calls ?? [])]
  expect(await f.browser.preview({ botId: f.bot.id, signal: f.ctx.signal })).toBeNull()
  expect(f.acquisitions).toHaveLength(1)
  expect(f.endpoints).toHaveLength(1)
  expect(f.transports[0]?.calls).toEqual(calls)
  expect(f.hostSpawns()).toBe(0)
})

test("interactive takeover operations reach the VM browser while a session lease keeps it running", async () => {
  const f = await fixture()
  const database = f.runtime.kernel.db as { run: (sql: string, ...args: string[]) => unknown }
  database.run("UPDATE bots SET browser = 'machine' WHERE id = ?", f.bot.id)

  expect((await f.browser.list({ botId: f.bot.id })).success).toBe(true)
  const tab = f.browser.tabsForBot(f.bot.id)[0]
  if (!tab) throw new Error("Missing guest browser tab")

  expect(await f.browser.holdTakeover({ tabId: tab.tabId, reason: "A sign-in is needed" })).toBe(true)
  const signal = new AbortController().signal
  const frame = await f.browser.takeoverFrame({ tabId: tab.tabId, botId: f.bot.id, signal })
  expect(frame).toMatchObject({
    image: "data:image/jpeg;base64,ZmFrZQ==",
    width: 800,
    height: 500,
  })
  if (!frame) throw new Error("Missing takeover frame")
  expect(
    await f.browser.takeoverInput({
      tabId: tab.tabId,
      botId: f.bot.id,
      targetEpoch: frame.targetEpoch,
      width: frame.width,
      height: frame.height,
      signal,
      input: { kind: "text", text: "private fixture value" },
    }),
  ).toBe(true)
  expect(f.transports[0]?.calls).toContain("Input.insertText")
  expect(await f.browser.releaseTakeover(tab.tabId)).toBe(true)
  expect(f.releases()).toBe(f.acquisitions.length)
  expect(f.hostSpawns()).toBe(0)
})

test("list returns empty when a VM stopped outside the runtime still appears running", async () => {
  const f = await fixture()
  await f.browser.list({ botId: f.bot.id })
  f.vm.acquire = async () => {
    throw new Error("A máquina não está em execução")
  }
  expect(await bounded(f.browser.list({ botId: f.bot.id }))).toMatchObject({ success: true, structured: { tabs: [] } })
  expect(f.transports[0]?.closes()).toBe(1)
})

test("restarting during a pending launcher retires it before the next operation", async () => {
  const f = await fixture()
  const endpoint = f.vm.browserEndpoint
  const pending = deferred<string | null>()
  const reached = deferred<void>()
  f.vm.browserEndpoint = () => {
    reached.resolve()
    return pending.promise
  }
  const first = f.browser.list({ botId: f.bot.id })
  await reached.promise
  f.publish({ status: "stopped" })
  f.publish({ status: "starting" })
  f.publish({ status: "running" })
  f.vm.browserEndpoint = endpoint
  expect((await bounded(first)).success).toBe(false)
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  pending.resolve("ws://obsolete")
  await Bun.sleep(5)
  expect(f.transports).toHaveLength(1)
})

for (const stage of ["CDP", "acquire", "launcher"] as const) {
  test(`list, open and snapshot bound a stuck ${stage} and recover`, async () => {
    const f = await fixture()
    for (const operation of ["list", "open", "snapshot"] as const) {
      await f.browser.list({ botId: f.bot.id })
      const tabId = f.browser.tabsForBot(f.bot.id)[0]?.tabId ?? ""
      const acquire = f.vm.acquire
      const endpoint = f.vm.browserEndpoint
      if (stage === "CDP") f.transports.at(-1)?.freeze()
      else if (stage === "acquire") f.vm.acquire = () => new Promise(() => {})
      else {
        f.publish({ status: "starting" })
        f.publish({ status: "running" })
        f.vm.browserEndpoint = () => new Promise(() => {})
      }
      const work =
        operation === "list"
          ? f.browser.list({ botId: f.bot.id })
          : operation === "open"
            ? f.browser.open({ url: "about:blank", ctx: f.ctx, timeoutMs: 1000 })
            : f.browser.snapshot({ botId: f.bot.id, tabId, image: "never", signal: f.ctx.signal })
      expect(await bounded(work)).toMatchObject({
        success: false,
        errorCode: "DEADLINE_EXCEEDED",
        error: expect.stringContaining("navegador da VM"),
      })
      f.vm.acquire = acquire
      f.vm.browserEndpoint = endpoint
      expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
    }
  })
}

test("a late CDP connection from a timed out launcher is closed without reviving it", async () => {
  const f = await fixture()
  const pending = deferred<CdpClient>()
  const browser = createRoutedBrowserEngine(f.runtime.kernel, "system-chrome", {
    guestTimeoutMs: 40,
    connect: () => pending.promise,
  })
  try {
    expect(await bounded(browser.list({ botId: f.bot.id }))).toMatchObject({
      success: false,
      errorCode: "DEADLINE_EXCEEDED",
    })
    const late = fakeCdp("late")
    pending.resolve(late.client)
    await Bun.sleep(5)
    expect(late.closes()).toBe(1)
    expect(late.calls).toEqual([])
  } finally {
    await browser.shutdown()
  }
})

test("abort and a stuck release cannot leave a browser call waiting forever", async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort()
  expect(await f.browser.list({ botId: f.bot.id, signal: controller.signal })).toMatchObject({ success: false })
  expect(f.acquisitions).toHaveLength(0)
  f.vm.acquire = async () => () => new Promise(() => {})
  expect(await bounded(f.browser.list({ botId: f.bot.id }))).toMatchObject({
    success: false,
    errorCode: "DEADLINE_EXCEEDED",
  })
})

test("browser_open surfaces the coded pt-BR cause when the guest browser never starts", async () => {
  const f = await fixture()
  f.vm.browserEndpoint = async () => {
    throw new BrowserStartError("exited", browserStartMessage({ reason: "exited", detail: "profile locked" }))
  }
  const result = await f.browser.open({ url: "https://example.test/", ctx: f.ctx, timeoutMs: 20_000 })
  const text = JSON.stringify(result)
  expect(text).toContain('"errorCode":"BROWSER_START_FAILED"')
  expect(text).toContain("O navegador da VM encerrou ao iniciar.")
  expect(text).toContain("profile locked")
  f.vm.browserEndpoint = async () => "ws://fake/devtools/browser"
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
})

test("browser_open honours timeoutMs below the guest default and reports a coded deadline", async () => {
  const f = await fixture()
  f.vm.browserEndpoint = () => new Promise<string | null>(() => {})
  const started = Date.now()
  const result = await f.browser.open({ url: "https://example.test/", ctx: f.ctx, timeoutMs: 15 })
  expect(Date.now() - started).toBeLessThan(200)
  expect(result).toMatchObject({ success: false, errorCode: "DEADLINE_EXCEEDED" })
})

test("a page-level browser failure keeps the live guest connection and its own pt-BR cause", async () => {
  const f = await fixture()
  const result = await bounded(f.browser.open({ url: "http://example.test/", ctx: f.ctx, timeoutMs: 30 }))
  expect(result).toMatchObject({ success: false, errorCode: "ENGINE_UNAVAILABLE" })
  expect((result as { error: string }).error).toContain("não conseguiu criar a aba")
  expect(f.transports).toHaveLength(1)
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  expect(f.transports).toHaveLength(1)
})

test("a failure on a frozen guest connection still retires it with the reconnect hint", async () => {
  const f = await fixture()
  await f.browser.list({ botId: f.bot.id })
  f.transports.at(-1)?.freeze()
  const result = await bounded(f.browser.open({ url: "http://example.test/", ctx: f.ctx, timeoutMs: 30 }))
  expect(result).toMatchObject({ success: false })
  expect((await bounded(f.browser.list({ botId: f.bot.id }))).success).toBe(true)
  expect(f.transports).toHaveLength(2)
})
