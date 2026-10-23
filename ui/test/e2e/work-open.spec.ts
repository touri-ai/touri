import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import type { Bot, BotGroup, Message, Thread } from "@touri/contracts"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
let releaseActivity: () => void = () => undefined
let releaseHistory: () => void = () => undefined
test.setTimeout(180_000)
test.use({ trace: "off" })

test.afterEach(async () => {
  releaseActivity()
  releaseHistory()
  await server?.dispose()
  server = null
})

test("Work opens with cached channels under 300 ms and channel history under one second", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  await seedWorkHistory(current)
  const { groups } = (await current.api("/groups")) as { groups: BotGroup[] }
  const group = groups.find((candidate) => candidate.name === "Planejamento")
  if (!group) throw new Error("Missing channel fixture")
  const { threads } = (await current.api(`/groups/${group.id}/threads`)) as { threads: Thread[] }
  const thread = threads.find((candidate) => candidate.title === "Conversa 45")
  if (!thread) throw new Error("Missing channel fixture")
  const { messages } = (await current.api(`/threads/${thread.id}/messages?all=true`)) as { messages: Message[] }
  const lastMessage = messages.at(-1)
  if (!lastMessage) throw new Error("Missing saved message fixture")
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  const session = await page.context().newCDPSession(page)
  await session.send("Network.enable")
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 60,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  const events: Array<{ ms: number; kind: string; path?: string; bytes?: number; type?: string }> = []
  const start = performance.now()
  // Listener callbacks record bounded metadata locally; payloads and credentials never leave the browser.
  const getPath = (url: string) => new URL(url).pathname.replace(/\/(bots|groups|threads)\/[^/]+/g, "/$1/:id")
  page.on("request", (request) => {
    events.push({ ms: performance.now() - start, kind: "request", path: getPath(request.url()) })
  })
  page.on("requestfinished", (request) => {
    events.push({ ms: performance.now() - start, kind: "response", path: getPath(request.url()) })
  })
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const text = payload.toString()
      const frame = JSON.parse(text) as { type?: string; event?: { type?: string } }
      events.push({
        ms: performance.now() - start,
        kind: "ws",
        bytes: text.length,
        type: frame.event?.type ?? frame.type,
      })
    }),
  )
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const text = payload.toString()
      const frame = JSON.parse(text) as { type?: string }
      events.push({ ms: performance.now() - start, kind: "ws-sent", bytes: text.length, type: frame.type })
    }),
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  const measure = async (reopen = false) => {
    await page.goto(current.serverUrl)
    const work = page.getByRole("tab", { name: /^Work,/ })
    await work.waitFor()
    const opened = performance.now()
    events.push({ ms: opened - start, kind: "work-open" })
    if ((await work.getAttribute("aria-selected")) !== "true") await work.click()
    const channel = page.getByRole("region", { name: "Canais", exact: true }).getByText(group.name, { exact: true })
    await channel.waitFor()
    const sidebarMs = performance.now() - opened
    events.push({ ms: performance.now() - start, kind: "sidebar-visible" })
    if (!reopen) {
      await channel.click()
      await page.getByRole("region", { name: "Canais", exact: true }).getByText(thread.title, { exact: true }).click()
    }
    const channelName = group.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    await expect(page.getByRole("textbox", { name: new RegExp(`Mensagem (?:para |em #)${channelName}`) })).toBeVisible()
    await expect(page.getByTestId("virtual-message-list").getByText(lastMessage.text, { exact: true })).toBeVisible()
    events.push({ ms: performance.now() - start, kind: "messages-visible" })
    return { sidebarMs, messagesMs: performance.now() - opened }
  }
  const cold = await measure()
  await page.waitForTimeout(250)
  const warm = await measure(true)
  releaseActivity()
  await page.unrouteAll({ behavior: "wait" })
  const result = {
    latencyMs: 60,
    activityHeldUntilMessages: false,
    cold,
    warm,
    events,
  }
  await info.attach("work-open-timing", { body: JSON.stringify(result, null, 2), contentType: "application/json" })
  if (process.env.TOURI_WORK_OPEN_EVIDENCE) {
    await mkdir(process.env.TOURI_WORK_OPEN_EVIDENCE, { recursive: true })
    await writeFile(join(process.env.TOURI_WORK_OPEN_EVIDENCE, "timing.json"), JSON.stringify(result, null, 2))
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.screenshot({
        path: join(process.env.TOURI_WORK_OPEN_EVIDENCE, `work-open-${width}.png`),
        animations: "disabled",
      })
      if (width === 390) await page.locator(".mobile-menu-button").click()
      await page.screenshot({
        path: join(process.env.TOURI_WORK_OPEN_EVIDENCE, `work-sidebar-${width}.png`),
        animations: "disabled",
      })
      if (width === 390) {
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog", { name: "Barra lateral" })).toBeHidden()
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value
          document.documentElement.classList.toggle("dark", value === "dark")
        }, theme)
        const audit = await new AxeBuilder({ page }).include(".chat-panel").analyze()
        expect(
          audit.violations.filter(
            (issue) => issue.impact === "serious" || issue.impact === "critical" || issue.id === "color-contrast",
          ),
        ).toEqual([])
      }
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "light"
        document.documentElement.classList.remove("dark")
      })
    }
  }
  console.log(JSON.stringify({ latencyMs: 60, cold, warm }))

  expect(warm.sidebarMs).toBeLessThan(300)
  expect(warm.messagesMs).toBeLessThan(1000)
})

const seedWorkHistory = async (current: Awaited<ReturnType<typeof createWorkGoldenServer>>) => {
  // Representative saved history stays synthetic and never starts a provider turn.
  const bots = await Promise.all(
    Array.from({ length: 9 }, async (_, index) => {
      const { bot } = (await current.api("/bots", "POST", {
        name: `Assistente ${index + 1}`,
        provider: seed.bots[0]?.provider,
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }
      return bot
    }),
  )
  for (const groupIndex of [0, 1, 2]) {
    const { group, thread } = (await current.api("/groups", "POST", {
      name: ["Projetos", "Equipe", "Planejamento"][groupIndex],
      color: "#558866",
      avatarShape: "cercle",
      memberIds: bots.slice(groupIndex * 3, groupIndex * 3 + 3).map((bot) => bot.id),
      coordinatorBotId: null,
    })) as { group: BotGroup; thread: Thread }
    for (const index of Array.from({ length: 45 }, (_, value) => value)) {
      const conversation =
        index === 0
          ? thread
          : (
              (await current.api(`/groups/${group.id}/threads`, "POST", { title: `Conversa ${index + 1}` })) as {
                thread: Thread
              }
            ).thread
      const messageCount = groupIndex * 45 + index < 80 ? 10 : 9
      let parentId: string | null = null
      for (const number of Array.from({ length: messageCount }, (_, value) => value)) {
        const { message } = (await current.api(`/threads/${conversation.id}/messages`, "POST", {
          text: `Registro de demonstração ${number + 1}. O plano da equipe está salvo para a próxima conversa.`,
          parentId,
          attachmentIds: [],
          sendId: crypto.randomUUID(),
        })) as { message: Message }
        parentId = message.id
      }
    }
  }
}

test("an existing conversation shows honest loading while history is pending", async ({ page }) => {
  test.setTimeout(90_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Lia",
    provider: seed.bots[0]?.provider,
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { group, thread } = (await current.api("/groups", "POST", {
    name: "Planejamento",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })) as { group: BotGroup; thread: Thread }
  await current.api(`/threads/${thread.id}/messages`, "POST", {
    text: "O plano de demonstração está salvo.",
    parentId: null,
    attachmentIds: [],
    sendId: crypto.randomUUID(),
  })
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  const history = new Promise<void>((done) => {
    releaseHistory = done
  })
  const activity = new Promise<void>((done) => {
    releaseActivity = done
  })
  await page.route("**/workspace/activity", async (route) => {
    await activity
    await route.continue().catch(() => undefined)
  })
  await page.route(`**/threads/${thread.id}/messages?*`, async (route) => {
    await history
    await route.continue().catch(() => undefined)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("region", { name: "Canais", exact: true }).getByText(group.name, { exact: true }).click()
  if (process.env.TOURI_WORK_OPEN_EVIDENCE) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.screenshot({
        path: join(process.env.TOURI_WORK_OPEN_EVIDENCE, `work-loading-${width}.png`),
        animations: "disabled",
      })
    }
  }

  await expect(page.getByRole("status", { name: "Carregando conversas…" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Comece a conversa em #Planejamento" })).toHaveCount(0)
  releaseHistory()
  await expect(page.getByTestId("virtual-message-list").getByText("O plano de demonstração está salvo.")).toBeVisible()
  releaseActivity()
})

test("history recovery remains available after repeated read failures", async ({ page }) => {
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Lia",
    provider: seed.bots[0]?.provider,
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { group, thread } = (await current.api("/groups", "POST", {
    name: "Planejamento",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })) as { group: BotGroup; thread: Thread }
  await current.api(`/threads/${thread.id}/messages`, "POST", {
    text: "O plano de demonstração está salvo.",
    parentId: null,
    attachmentIds: [],
    sendId: crypto.randomUUID(),
  })
  await current.install(page)
  let failures = 0
  await page.route(`**/threads/${thread.id}/messages?*`, async (route) => {
    if (failures >= 2) return route.continue()
    failures += 1
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Synthetic history failure"}' })
  })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("region", { name: "Canais", exact: true }).getByText(group.name, { exact: true }).click()
  const retry = page.getByRole("button", { name: "Tentar novamente", exact: true })
  await expect(retry).toBeVisible()
  if (process.env.TOURI_WORK_OPEN_EVIDENCE) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.screenshot({
        path: join(process.env.TOURI_WORK_OPEN_EVIDENCE, `work-retry-${width}.png`),
        animations: "disabled",
      })
    }
  }
  await retry.click()
  await expect.poll(() => failures).toBe(2)
  await expect(retry).toBeEnabled()
  await expect(page.getByText("Não foi possível carregar a conversa. Tente novamente.", { exact: true })).toBeVisible()
  await retry.click()

  await expect(page.getByTestId("virtual-message-list").getByText("O plano de demonstração está salvo.")).toBeVisible()
  await expect(retry).toHaveCount(0)
})
