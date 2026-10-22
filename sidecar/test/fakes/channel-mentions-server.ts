import type { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderAdapter } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { init as initNotify } from "../../src/notify"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

const appData = await mkdtemp(join(tmpdir(), "touri-channel-mentions-"))
const host = createKernel({ appData })
await initStore(host.kernel)
await initGroups(host.kernel)
await initNotify(host.kernel)
const notifyFixture = process.env.TOURI_NOTIFY_FIXTURE === "1"
if (notifyFixture)
  host.kernel.services.provide("work.channelPeople", () => [
    { id: "owner", name: "thiago", handle: "thiago", avatarSeed: "owner", role: "admin" },
  ])
const store = host.kernel.services.use("store.api")
if (!store) throw new Error("Store missing")
const database = host.kernel.db as Database
// This fixture exercises channel turns, not provider installation or bot-home generation.
const bots = await Promise.all(
  ["codador", "revisor"].map(async (name) => {
    const home = join(appData, name)
    await mkdir(home)
    database
      .query(
        "INSERT INTO bots(id,name,provider,home_dir,main_thread_id,created_at,updated_at) VALUES (?,?,'codex',?,?,1,1)",
      )
      .run(name, name, home, `${name}-main`)
    database
      .query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES (?,?,'main',?,1,1)")
      .run(`${name}-main`, name, name)
    const bot = store.getBot({ botId: name })
    if (!bot) throw new Error("Channel fixture bot missing")

    return bot
  }),
)
const provider: ProviderAdapter = {
  provider: "codex",
  detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
  startTurn: async ({ thread, onEvent }) => {
    if (notifyFixture) {
      const prompt = store.activePath({ threadId: thread.id }).find((message) => message.role === "system")?.text ?? ""
      if (
        !prompt.includes('"handle":"thiago"') ||
        !prompt.includes("Para chamar uma pessoa, escreva @nome; use só quando precisar dela.")
      )
        throw new Error("Channel people context missing")
    }
    const name = store.getBot({ botId: thread.botId })?.name ?? "bot"
    onEvent({ type: "turn_started", externalTurnId: thread.id })
    onEvent({
      type: "text_delta",
      itemId: thread.id,
      delta: notifyFixture ? "@thiago preciso de você" : `${name} respondeu.`,
    })
    return { success: true, externalSessionId: thread.id, rolloutPath: null, status: "succeeded" }
  },
  answerApproval: async () => ({ success: true }),
  shutdown: async () => {},
}
const engine = createRuntimeEngine({
  kernel: host.kernel,
  providerAdapters: { codex: provider },
  environment: { PATH: process.env.PATH ?? "" },
})
await engine.ready
const runtime = createGroupRuntime(host.kernel, engine)
host.kernel.services.provide("runtime.enqueue", runtime.enqueue)
host.kernel.services.provide("groups.runtime", runtime)
const groups = createGroupStore(host.kernel)
const group = groups.save({
  name: "produto",
  color: "#2563eb",
  avatarShape: "classic-none",
  memberIds: bots.map((bot) => bot.id),
  coordinatorBotId: bots[1]?.id ?? null,
})
const thread = groups.createThread(group)
host.kernel.registerRoutes({
  name: "channel-mentions-fixture",
  routes: [
    {
      method: "GET",
      path: "/channel-mentions-state",
      handler: async () => ({
        status: 200,
        json: {
          messages: store.activePath({ threadId: thread.id }),
          runs: runtime.listRuns(thread.id),
          notifications: createNotificationStore({ db: host.kernel.db as Database }).recent(50),
        },
      }),
    },
  ],
})
const stop = async () => {
  runtime.shutdown()
  await engine.shutdown()
  await host.stop()
  await rm(appData, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())
console.log(`CHANNEL_FIXTURE ${JSON.stringify({ port: host.handshake.port, bots, group, thread })}`)
