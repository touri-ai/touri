import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run, ToolContext, ToolRegistration } from "@touri/contracts"
import { init } from "../../src/browser"
import { createBrowserEngine } from "../../src/browser/engine"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

test("automatic login handoff targets the requester and keeps the browser run resumable", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-automatic-handoff-"))
  const runtime = createKernel({ appData: root })
  const database = runtime.kernel.db as Database
  const registeredTools = Promise.withResolvers<ToolRegistration[]>()
  const kernel = new Proxy(runtime.kernel, {
    get(target, key) {
      if (key === "registerTools")
        return ({ tools: registered }: { tools: ToolRegistration[] }) => {
          registeredTools.resolve(registered)
          return target.registerTools({ tools: registered })
        }
      return Reflect.get(target, key)
    },
  })
  const engine = createBrowserEngine({ kernel })
  cleanups.add(async () => {
    await engine.shutdown()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,responsible_person_id)
      VALUES ('leo','Léo','codex','/workspace',1,1,'owner');
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
      VALUES ('travel','Viagens','#888888','circle','travel',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('channel','leo','Viagens',1,1,'travel',NULL), ('child','leo','Viagens',1,1,'travel','channel');
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,requester_person_id)
      VALUES ('first','child','leo','codex','user','running',1,'ana'),
        ('resumed','child','leo','codex','retry','running',2,'ana');
  `)
  kernel.services.provide("work.personChannelIds", () => ["travel"])
  const notification = new Promise<{ targetPersonId?: string | null }>((resolve) => {
    kernel.services.provide("notify.emit", (input) => {
      resolve(input)
      return {
        id: 1,
        level: "info",
        botName: "Léo",
        botColor: "#888888",
        avatarShape: "classic-none",
        botId: "leo",
        threadId: "channel",
        kind: "takeover",
        title: "",
        body: "",
        createdAt: 1,
        readAt: null,
        resolvedAt: null,
        resolution: null,
        requestId: null,
      }
    })
  })
  const requestTakeover = async (input: { notify?: boolean }) => ({
    success: true as const,
    structured: { status: "waiting_for_person", notify: input.notify },
  })
  await init(kernel, undefined, {
    engine: Object.assign({}, engine, {
      requestTakeover,
    }),
  })
  const context: ToolContext = {
    botId: "leo",
    threadId: "child",
    runId: "first",
    projectId: null,
    cwd: root,
    signal: new AbortController().signal,
  }
  const tools = await registeredTools.promise
  const click = tools.find((tool) => tool.name === "browser_submit_secret")
  if (!click) throw new Error("Browser click was not registered")

  const result = await click.handler({ ctx: context, args: { tabId: "tab", target: "Entrar" } })
  const run: Run = {
    id: "first",
    botId: "leo",
    threadId: "child",
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
  kernel.publish({ type: "run.updated", run })

  expect(result).toMatchObject({ success: true, structured: { status: "waiting_for_person", notify: false } })
  expect(await notification).toMatchObject({ targetPersonId: "ana" })
  expect(
    database.query("SELECT status,needs_you_at FROM browser_channel_runs WHERE run_id = 'first'").get(),
  ).toMatchObject({
    status: "needs_you",
    needs_you_at: expect.any(Number),
  })
  database.exec(`
    UPDATE browser_channel_runs SET status = 'running' WHERE run_id = 'first';
    INSERT INTO browser_takeover_continuations VALUES ('resumed','first','first',2);
  `)
  const resumed = await click.handler({
    ctx: Object.assign({}, context, { runId: "resumed" }),
    args: { tabId: "tab", target: "Entrar" },
  })

  expect(resumed.success).toBe(true)
})
