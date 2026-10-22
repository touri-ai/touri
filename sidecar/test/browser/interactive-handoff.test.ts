import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RouteModule, Run, ToolContext, ToolRegistration } from "@touri/contracts"
import { init } from "../../src/browser"
import { connectCdpWebSocket } from "../../src/browser/cdp"
import { createBrowserEngine } from "../../src/browser/engine"
import { parseDevToolsActivePort } from "../../src/browser/launcher"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { init as initStore } from "../../src/store"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

const hasBrowser = Boolean(Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chromium-browser"))

test.skipIf(!hasBrowser).each(["ana", "owner"])(
  "%s can type, navigate and hand back a real channel browser twice",
  async (personId) => {
    const root = await mkdtemp(join(tmpdir(), "touri-interactive-handoff-"))
    const runtime = createKernel({ appData: root })
    const registered = Promise.withResolvers<ToolRegistration[]>()
    const routes = Promise.withResolvers<RouteModule>()
    const kernel = new Proxy(runtime.kernel, {
      get(target, key) {
        if (key === "registerTools")
          return (input: { tools: ToolRegistration[] }) => {
            registered.resolve(input.tools)
            return target.registerTools(input)
          }
        if (key === "registerRoutes")
          return (module: RouteModule) => {
            if (module.name === "browser") routes.resolve(module)
            return target.registerRoutes(module)
          }
        return Reflect.get(target, key)
      },
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new Response(
          new URL(request.url).pathname === "/done"
            ? "<html><body>Consulta concluída: quatro estadias disponíveis.</body></html>"
            : '<html><body><input aria-label="Nome" style="position:absolute;left:20px;top:20px;width:180px;height:40px"><button style="position:absolute;left:20px;top:80px;width:180px;height:40px" onclick="location.href=\'/done\'">Entrar</button></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    })
    cleanups.add(async () => {
      await runtime.stop()
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    })
    const profile = join(root, "chrome")
    await mkdir(profile, { recursive: true })
    const executable = Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chromium-browser")
    if (!executable) throw new Error("Missing test browser")
    // Only this disposable browser bypasses the sandbox; production launch flags stay unchanged.
    const chrome = Bun.spawn(
      [
        executable,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    cleanups.add(async () => {
      chrome.kill()
      await chrome.exited
    })
    const startupDeadline = performance.now() + 30_000
    const getEndpoint = async (): Promise<string> => {
      const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "")
      const endpoint = parseDevToolsActivePort(text)
      if (endpoint) return `ws://127.0.0.1:${endpoint.port}${endpoint.path}`
      if (chrome.exitCode !== null || performance.now() >= startupDeadline)
        throw new Error("Test browser did not start")
      await Bun.sleep(50)
      return getEndpoint()
    }
    const client = await connectCdpWebSocket({ url: await getEndpoint(), timeoutMs: 30_000 })
    const engine = createBrowserEngine({
      kernel,
      localBrowser: true,
      profile: "local",
      launcher: {
        start: async () => ({ client }),
        stop: async () => {
          await client.close()
        },
      },
    })
    cleanups.add(() => engine.shutdown())
    await initStore(kernel)
    const database = kernel.db as Database
    await mkdir(join(root, "bots", "leo"), { recursive: true })
    database
      .query(
        "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id) VALUES ('leo','Léo','codex',?,1,1,'owner')",
      )
      .run(join(root, "bots", "leo"))
    database.exec(`
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('travel','Viagens','#888888','circle','travel',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('channel','leo','Viagens',1,1,'travel',NULL), ('child','leo','Viagens',1,1,'travel','channel');
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,requester_person_id)
      VALUES ('first','child','leo','codex','user','running',1,'ana');
  `)
    kernel.services.provide("work.personChannelIds", () => ["travel"])
    kernel.services.provide("work.ownsBot", ({ personId: actor }) => actor === "owner")
    kernel.services.provide("work.canAccessBrowserTab", ({ personId: actor }) => ["ana", "owner"].includes(actor))
    await init(kernel, undefined, { engine })
    const tools = await registered.promise
    const module = await routes.promise
    const context: ToolContext = {
      botId: "leo",
      threadId: "child",
      runId: "first",
      projectId: null,
      cwd: root,
      signal: new AbortController().signal,
    }
    const opened = await engine.open({ url: `http://127.0.0.1:${server.port}/`, ctx: context, timeoutMs: 30_000 })
    expect(opened).toMatchObject({ success: true })
    const tab = engine.tabsForBot("leo")[0]
    if (!tab) throw new Error("Missing browser tab")
    const targets = await client.call<{ targetInfos: Array<{ targetId: string; url: string }> }>(
      "Target.getTargets",
      {},
    )
    const target = targets.targetInfos.find((target) => target.url.startsWith(`http://127.0.0.1:${server.port}/`))
    if (!target) throw new Error("Missing fixture page")
    const observer = await client.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    const waitForLogin = async (deadline = performance.now() + 30_000): Promise<void> => {
      const page = await client
        .call<{ result: { value: boolean } }>(
          "Runtime.evaluate",
          { expression: "Boolean(document.querySelector('input'))", returnByValue: true },
          observer.sessionId,
        )
        .catch(() => null)
      if (page?.result.value) return
      if (performance.now() >= deadline) throw new Error("The login fixture did not load")

      await Bun.sleep(50)
      return waitForLogin(deadline)
    }
    const handoff = tools.find((tool) => tool.name === "browser_submit_secret")
    if (!handoff) throw new Error("Missing handoff tool")
    const signal = new AbortController().signal
    bindDeviceSession(signal, {
      deviceId: personId,
      person: { id: personId, name: personId, email: null, avatarSeed: personId, role: "member" },
      active: () => true,
    })
    const request = async (method: string, action: string, body: unknown) => {
      const route = module.routes.find(
        (route) => route.method === method && route.path === `/browser/tabs/:id/takeover/${action}`,
      )
      if (!route) throw new Error("Missing control route")
      const response = await route.handler({ params: { id: tab.tabId }, query: {}, body, signal })
      if (!("json" in response)) throw new Error("Expected JSON")
      return response
    }
    const run: Run = {
      id: "first",
      threadId: "child",
      botId: "leo",
      provider: "codex",
      trigger: "user",
      status: "succeeded",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: 2,
    }

    for (const attempt of [1, 2]) {
      expect((await handoff.handler({ ctx: context, args: { tabId: tab.tabId } })).success).toBe(true)
      kernel.publish({ type: "run.updated", run })
      const started = await request("POST", "session", {})
      expect(started.status).toBe(200)
      const credentials = started.json as { sessionId: string; controlEpoch: string; viewEpoch: number }
      const capture = await request("POST", "frame", credentials)
      expect(capture.status).toBe(200)
      const frame = capture.json as { targetEpoch: number; width: number; height: number }
      const input = (value: unknown) =>
        request("POST", "input", Object.assign({}, credentials, frame, { input: value }))

      expect((await input({ kind: "click", x: 60 / frame.width, y: 40 / frame.height })).status).toBe(200)
      expect((await input({ kind: "text", text: "entrada privada fictícia" })).status).toBe(200)
      const typed = await client.call<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.querySelector('input').value", returnByValue: true },
        observer.sessionId,
      )
      expect(typed.result.value).toBe("entrada privada fictícia")
      expect((await input({ kind: "click", x: 60 / frame.width, y: 100 / frame.height })).status).toBe(200)
      expect((await request("DELETE", "session", credentials)).status).toBe(200)
      const result = await engine.snapshot({ tabId: tab.tabId, botId: "leo", image: "never", signal: context.signal })
      expect(JSON.stringify(result)).not.toContain("entrada privada fictícia")
      expect(engine.tabsForBot("leo")[0]?.heldByUser).toBe(false)
      if (attempt === 1) {
        await client.call("Page.navigate", { url: `http://127.0.0.1:${server.port}/` }, observer.sessionId)
        await waitForLogin()
      }
    }
  },
  120_000,
)
