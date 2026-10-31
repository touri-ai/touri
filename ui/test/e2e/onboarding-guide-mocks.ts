import { readFile } from "node:fs/promises"
import type { Page, WebSocketRoute } from "@playwright/test"
import type { Bot, BotGroup, Message } from "@touri/contracts"
import {
  getGuideBotFixture,
  getGuideGroupFixture,
  getGuidePreviewFixture,
  getGuideSourceFixture,
  getGuideThreadFixture,
} from "../fixtures/onboarding-guide"

export const installGuideMocks = async (
  page: Page,
  { team = true, agentCount = 1, agentNames }: { team?: boolean; agentCount?: number; agentNames?: string[] } = {},
) => {
  const protocol = JSON.parse(
    await readFile(new URL("../../../packages/contracts/protocol.json", import.meta.url), "utf8"),
  ) as { version: number; legacySchemaVersion: number }
  // These collections are the disposable server state owned by the route mock.
  let bots: Bot[] = []
  let groups: BotGroup[] = []
  let messages: Message[] = []
  let socket: WebSocketRoute | undefined
  let seq = 0
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = []
  const imports = Promise.withResolvers<void>()
  const names = agentNames ?? ["dev", "ops", "design"].slice(0, agentCount)
  const preview = getGuidePreviewFixture()
  const template = preview.agents[0]
  if (!template) throw new Error("Missing synthetic preview agent")
  const agents = names.map((name) => ({ ...template, key: name, name, suggestedBotName: name }))
  await page.routeWebSocket("**/api/v1/events?*", (connection) => {
    socket = connection
    connection.send(JSON.stringify({ type: "resync", lastSeq: 0 }))
  })
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace("/api/v1", "")
    const method = request.method()
    const body = request.postDataJSON() as Record<string, unknown> | null
    calls.push({ path, method, body: body ?? {} })
    const reply = (value: unknown, status = 200) => route.fulfill({ status, json: value })
    if (path === "/health")
      return reply({
        ok: true,
        version: "0.3.0",
        schemaVersion: protocol.legacySchemaVersion,
        protocolVersion: protocol.version,
        hostKind: "computer",
      })
    if (path === "/ws-ticket") return reply({ ticket: "synthetic-ticket" })
    if (path === "/onboarding")
      return reply(
        method === "POST"
          ? { completed: true, url: null }
          : { completed: false, hasData: false, tailscale: "missing", remoteUrl: null },
      )
    if (path === "/import/sources") return reply({ sources: [getGuideSourceFixture()] })
    if (path === "/folders" && method === "GET") {
      // A fake home with enough folders to scroll; each read waits like a real disk listing.
      await new Promise((resolve) => setTimeout(resolve, 60))
      const folder = new URL(request.url()).searchParams.get("path") ?? "/srv/exemplo"
      return reply({
        canGrant: true,
        home: "/srv/exemplo",
        path: folder,
        parent: folder === "/srv/exemplo" ? null : folder.slice(0, folder.lastIndexOf("/")) || "/",
        folders: Array.from({ length: 14 }, (_, index) => ({
          name: `agentes-${index + 1}`,
          path: `${folder}/agentes-${index + 1}`,
        })),
        truncated: false,
      })
    }
    if (path === "/import/preview") return reply({ ...preview, agents })
    if (path === "/import/apply") {
      seq += 1
      socket?.send(
        JSON.stringify({
          seq,
          at: Date.now(),
          event: {
            type: "agent.import.progress",
            importId: "import-one",
            agentKey: "dev",
            step: "skills",
            done: 1,
            total: 4,
          },
        }),
      )
      await imports.promise
      bots = names.map(getGuideBotFixture)
      return reply({
        importId: "import-one",
        bots: names.map((name) => ({ agentKey: name, botId: `bot-${name}` })),
        pausedRoutines: 1,
        reconnect: [],
      })
    }
    if (path === "/import/undo") {
      const removedBots = bots.filter((bot) => names.includes(bot.name)).length
      bots = bots.filter((bot) => !names.includes(bot.name))
      return reply({ removedBots })
    }
    if (path === "/bots" && method === "GET") return reply({ bots })
    if (path === "/bots" && method === "POST") {
      const bot = { ...getGuideBotFixture(), ...body, id: "bot-touri" }
      bots = [...bots, bot]
      return reply({ bot })
    }
    if (/^\/bots\/[^/]+$/.test(path) && method === "PATCH") {
      const id = path.split("/").at(-1)
      bots = bots.map((bot) => (bot.id === id ? { ...bot, ...body } : bot))
      return reply({ bot: bots.find((bot) => bot.id === id) })
    }
    if (path.includes("provider-login/flow"))
      return reply({ provider: "claude", state: "ready", executable: "available", hostKind: "computer" })
    if (path.endsWith("provider-login")) return reply({ configured: true, source: "host", hostAvailable: true })
    if (path === "/groups" && method === "GET") return reply({ groups })
    if (path === "/groups" && method === "POST") {
      const group = { ...getGuideGroupFixture(), ...body, id: String(body?.name) }
      groups = [...groups, group]
      return reply({ group, thread: getGuideThreadFixture() })
    }
    if (/\/groups\/[^/]+\/threads/.test(path))
      return reply({ threads: [{ ...getGuideThreadFixture(), groupId: "geral" }] })
    if (path === "/threads/general-thread/messages" && method === "POST") {
      const message: Message = {
        id: "first-message",
        threadId: "general-thread",
        parentId: null,
        role: "user",
        kind: "text",
        status: "complete",
        runId: null,
        text: String(body?.text),
        parts: [{ type: "text", text: String(body?.text) }],
        sender: null,
        source: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      messages = [message]
      return reply({ message, run: null })
    }
    if (path.endsWith("/messages")) return reply({ messages, activeLeafId: "first-message" })
    if (path.endsWith("/transcript"))
      return reply({ entries: [], rejections: [], lastSeq: 0, generation: 0, hasMore: false, resync: false })
    if (path.endsWith("/threads")) return reply({ threads: [] })
    if (path.endsWith("/runs") || path === "/runs") return reply({ runs: [] })
    if (path === "/public-address") return reply({ address: "https://team.example.com", reachability: "public" })
    if (path === "/invites") return reply({ invites: [] }, team ? 200 : 404)
    if (path === "/machines")
      return reply({ capability: { available: false, reason: null, provider: null }, machines: [] })
    if (path === "/session")
      return reply({
        ok: true,
        kind: "device",
        person: { id: "owner", name: "Pessoa exemplo", email: null, avatarSeed: "owner", role: "admin" },
      })
    if (path === "/workspace/activity") return reply({ messages: [], runs: [], browserRuns: [] })
    const collections: Record<string, unknown> = {
      "/recovery": { tasks: [] },
      "/storage/bot-deletions": { deletions: [] },
      "/notifications/pending": { notifications: [] },
      "/projects": { projects: [] },
      "/settings": {
        settings: {
          maxConcurrentRuns: 1,
          defaultProvider: "claude",
          cloneRoot: "/workspace",
          nativeNotifications: true,
        },
      },
      "/previews": { previews: [] },
      "/browser/tabs": { tabs: [] },
      "/routines": { routines: [], runs: [] },
      "/routine-runs": { routineRuns: [] },
      "/notifications": { notifications: [] },
      "/people": { people: [] },
      "/api-models": { models: [], executorAvailable: true },
      "/cloud/account": { connected: false },
      "/doctor": { checks: [] },
    }
    return reply(collections[path] ?? {}, collections[path] ? 200 : 404)
  })
  return { calls, finishImport: () => imports.resolve(), getBots: () => bots }
}
