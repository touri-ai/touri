import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, ProviderAdapter } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createGroupRuntime } from "../../src/groups/runtime"
import { createGroupStore } from "../../src/groups/store"
import { createKernel } from "../../src/kernel"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { init as initStore } from "../../src/store"

const appData = await mkdtemp(join(tmpdir(), "touri-channel-mentions-"))
const host = createKernel({ appData })
await initStore(host.kernel)
await initGroups(host.kernel)
const store = host.kernel.services.use("store.api")
if (!store) throw new Error("Store missing")
const request = async (path: string, body: unknown) => {
  const response = await fetch(`http://127.0.0.1:${host.handshake.port}/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status}`)

  return response.json()
}
const bots = await Promise.all(
  ["codador", "revisor"].map(async (name) => {
    const result = (await request("/bots", {
      name,
      provider: "codex",
      instructions: "Responda somente com seu nome.",
    })) as { bot: Bot }
    return result.bot
  }),
)
const provider: ProviderAdapter = {
  provider: "codex",
  detect: async () => ({ success: true, path: "/fixtures/provider", version: "1", loggedIn: true }),
  startTurn: async ({ thread, onEvent }) => {
    const name = store.getBot({ botId: thread.botId })?.name ?? "bot"
    onEvent({ type: "turn_started", externalTurnId: thread.id })
    onEvent({ type: "text_delta", itemId: thread.id, delta: `${name} respondeu.` })
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
        json: { messages: store.activePath({ threadId: thread.id }), runs: runtime.listRuns(thread.id) },
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
