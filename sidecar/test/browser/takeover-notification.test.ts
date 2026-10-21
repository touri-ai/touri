import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NotificationRecord, NotifyInput, NotifyResolution } from "@touri/contracts"
import { createBrowserEngine } from "../../src/browser/engine"
import { createKernel } from "../../src/kernel"

test("a browser handoff creates a needs-you notification and resolves it on return", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-takeover-notification-"))
  const runtime = createKernel({ appData: root })
  let notifications: Array<NotifyInput> = []
  let resolutions: Array<{ requestId: string; resolution: NotifyResolution }> = []
  let resumptions: Array<{ botId: string; threadId: string; runId: string }> = []
  let engine: ReturnType<typeof createBrowserEngine> | null = null
  try {
    const database = runtime.kernel.db as { run: (sql: string, ...args: Array<unknown>) => unknown }
    database.run(
      "INSERT INTO bots (id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Lia','codex','/bots/lia',1,1)",
    )
    database.run(
      "INSERT INTO threads (id,bot_id,kind,title,created_at,updated_at) VALUES ('thread','bot','main','Login',1,1)",
    )
    database.run(
      "INSERT INTO browser_tabs (id,owner_bot_id,owner_thread_id,url,state,created_at,last_used_at) VALUES ('tab','bot','thread','https://travel.example.test/login?token=fixture-secret','live',1,1)",
    )
    runtime.kernel.services.provide("notify.emit", (input) => {
      notifications = [...notifications, input]
      return {
        id: 1,
        kind: input.kind,
        level: "warning",
        botId: input.botId,
        botName: "Lia",
        botColor: "#123456",
        avatarShape: "classic-none",
        threadId: input.threadId,
        title: input.title,
        body: input.body,
        requestId: input.requestId ?? null,
        createdAt: Date.now(),
        resolvedAt: null,
        resolution: null,
      } satisfies NotificationRecord
    })
    runtime.kernel.services.provide("notify.resolve", (input) => {
      resolutions = [...resolutions, input]
    })
    runtime.kernel.services.provide("runtime.resumeAfterBrowserTakeover", (input) => {
      resumptions = [...resumptions, input]
      return true
    })
    engine = createBrowserEngine({
      kernel: runtime.kernel,
      discoverBotId: "bot",
      launcher: { start: async () => null, stop: async () => {} },
    })

    const pending = engine.requestTakeover({
      tabId: "tab",
      botId: "bot",
      reason: "login",
      reasonCode: "login",
      timeoutMs: 10000,
      signal: new AbortController().signal,
      threadId: "thread",
      runId: "run",
    })
    const result = await Promise.race([pending, Bun.sleep(500).then(() => null)])
    expect(result).toMatchObject({ success: true, structured: { status: "waiting_for_person" } })
    expect(notifications).toMatchObject([{ kind: "takeover", requestId: expect.any(String) }])
    expect(JSON.stringify(notifications)).not.toContain("fixture-secret")
    expect(engine.tabsForBot("bot")[0]?.url).toBe("")
    expect(await engine.releaseTakeover("tab")).toBe(true)
    await Bun.sleep(0)

    expect(resolutions).toMatchObject([{ requestId: notifications[0]?.requestId, resolution: "replied" }])
    expect(resumptions).toEqual([{ botId: "bot", threadId: "thread", runId: "run" }])
  } finally {
    await engine?.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
