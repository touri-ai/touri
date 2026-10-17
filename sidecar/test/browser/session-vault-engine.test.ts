import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Bot, Kernel, ToolContext } from "@touri/contracts"
import { createBrowserEngine } from "../../src/browser/engine"
import { botSessionPath, loadBotSession, saveBotSession } from "../../src/browser/sessionVault"
import type { CdpClient, JsonObject } from "../../src/browser/types"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

test("a locked saved session creates no empty context; retry restores the original cookies", async () => {
  const f = testKernel()
  const keys = new Map<string, string>()
  let locked = false
  f.kernel.callHost = (async (method: string, input: { account: string; value?: string }) => {
    if (locked) return { success: false, errorCode: "VAULT_ACCESS_REQUIRED", error: "locked" }
    if (method === "keychain.set") keys.set(input.account, input.value ?? "")
    return { success: true, value: { value: keys.get(input.account) ?? null } }
  }) as Kernel["callHost"]
  const calls: { method: string; params: JsonObject }[] = []
  const client: CdpClient = {
    call: async <T>(method: string, params: JsonObject = {}) => {
      calls.push({ method, params })
      if (method === "Target.createBrowserContext") return { browserContextId: "restored" } as T
      if (method === "Target.createTarget") return { targetId: "target" } as T
      if (method === "Target.attachToTarget") return { sessionId: "session" } as T
      // Stop after context restoration; page rendering is outside this regression.
      if (method === "Runtime.evaluate") throw new Error("synthetic page unavailable")
      return {} as T
    },
    subscribe: () => () => {},
    close: async () => {},
    isClosed: () => false,
  }
  const engine = createBrowserEngine({
    kernel: f.kernel,
    launcher: { start: async () => ({ client }), stop: async () => {} },
  })
  try {
    await initStore(f.kernel)
    const { bot } = (await f.request("POST /bots", { name: "Bot de teste", provider: "codex" })).json as { bot: Bot }
    const session = {
      cookies: [{ name: "session", value: "synthetic-cookie", domain: "example.test", path: "/" }],
      storage: {},
    }
    expect(await saveBotSession({ kernel: f.kernel, botId: bot.id, session })).toBe(true)
    const path = botSessionPath(f.kernel, bot.id)
    const before = readFileSync(path)
    const ctx: ToolContext = {
      botId: bot.id,
      threadId: bot.mainThreadId ?? "",
      runId: null,
      projectId: null,
      cwd: f.kernel.paths.appData,
      signal: new AbortController().signal,
    }
    locked = true
    const failed = await engine.open({ url: "about:blank", ctx, timeoutMs: 300 })
    expect(failed.success).toBe(false)
    expect(JSON.stringify(failed)).toContain("Diagnóstico")
    expect(calls.some((call) => call.method === "Target.createBrowserContext")).toBe(false)
    expect(readFileSync(path)).toEqual(before)
    locked = false
    await engine.open({ url: "about:blank", ctx, timeoutMs: 300 })
    expect(calls.find((call) => call.method === "Storage.setCookies")?.params.cookies).toMatchObject(session.cookies)
    expect(await loadBotSession(f.kernel, bot.id)).toEqual(session)
  } finally {
    // A failed storage collection cannot save an empty synthetic page on shutdown.
    locked = true
    await engine.shutdown()
    f.close()
  }
})
