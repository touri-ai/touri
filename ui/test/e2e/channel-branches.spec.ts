import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import type { Bot, BotGroup, Message, Run, Thread } from "@touri/contracts"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createWorkGoldenServer } from "./work-golden-server"

type ChannelServer = Awaited<ReturnType<typeof createWorkGoldenServer>>
const test = base.extend<{ server: ChannelServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture has no dependencies.
  server: async ({}, use) => use(await createWorkGoldenServer()),
})

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 })
test.afterEach(async ({ server }) => server.dispose())

test("channel history keeps independent roots and live common-parent messages", async ({ page, server }, info) => {
  test.setTimeout(180_000)
  const { bot } = (await server.api("/bots", "POST", {
    name: "Mapas",
    provider: seed.bots[0]?.provider,
    providerProfile: "demo",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  await saveSyntheticProfile(server, bot)
  const { group, thread } = (await server.api("/groups", "POST", {
    name: "planejamento-demo",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })) as { group: BotGroup; thread: Thread }
  const route = `/threads/${thread.id}/messages`
  const { message: human } = (await server.api(route, "POST", {
    text: "Vamos conferir os mapas de demonstração.",
    parentId: null,
  })) as { message: Message }
  const { message: integration } = (await server.api(route, "POST", {
    text: "Uma publicação fictícia ficou pronta para revisão.",
    parentId: null,
    as: { kind: "integration", name: "Publicações demo" },
  })) as { message: Message }
  const getHistory = async () => (await server.api(`${route}?all=true`)) as { messages: Message[] }
  const saved = await getHistory()

  expect(human.parentId).toBeNull()
  expect(integration.parentId).toBeNull()
  expect(integration.sender?.kind).toBe("integration")
  await server.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(server.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: new RegExp(`^${group.name}(?:,|$)`) })
    .first()
    .click()
  const history = page.getByTestId("virtual-message-list")
  await expect(history.getByText(human.text, { exact: true })).toBeVisible()
  await expect(history.getByText(integration.text, { exact: true })).toBeVisible()

  await expect(history.getByRole("group", { name: "Ramificações da mensagem" })).toHaveCount(0)
  await expect(history.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.evaluate(() => document.fonts.ready)
    const name = `after-channel-branches-${width}.png`
    const path = process.env.TOURI_E2E_EVIDENCE_DIR
      ? join(process.env.TOURI_E2E_EVIDENCE_DIR, name)
      : info.outputPath(name)
    await page.screenshot({ path, animations: "disabled" })
    await info.attach(name, { path, contentType: "image/png" })
  }
  expect((await getHistory()).messages).toEqual(saved.messages)

  const live = (await Promise.all([
    server.api(route, "POST", { text: "Primeira conferência independente.", parentId: human.id }),
    server.api(route, "POST", {
      text: "Segunda conferência independente.",
      parentId: human.id,
      as: { kind: "integration", name: "Publicações demo" },
    }),
  ])) as Array<{ message: Message }>
  for (const { message } of live) {
    expect(message.parentId).toBe(human.id)
    await expect(history.getByText(message.text, { exact: true })).toBeVisible()
  }
  await expect(history.getByRole("group", { name: "Ramificações da mensagem" })).toHaveCount(0)
  const persisted = await getHistory()
  expect(persisted.messages).toHaveLength(4)

  await page.reload()

  for (const message of persisted.messages) await expect(history.getByText(message.text, { exact: true })).toBeVisible()
  await expect(history.getByRole("group", { name: "Ramificações da mensagem" })).toHaveCount(0)
  expect((await getHistory()).messages).toEqual(persisted.messages)

  await server.setScenario({
    deltas: ["Conferindo os mapas. ", "Conferência finalizada."],
    pauseAfterFirstDelta: info.outputPath("release-stream"),
    exitOnInterrupt: true,
  })
  const input = page.getByRole("textbox", { name: /Mensagem (?:para |em #)planejamento-demo/ })
  await input.fill("@Mapas confira os mapas.")
  await input.press("Enter")
  await expect(history.getByText("Conferindo os mapas.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(history.getByRole("group", { name: "Ramificações da mensagem" })).toHaveCount(0)
  await page.getByRole("button", { name: "Parar", exact: true }).click()
  await expect
    .poll(async () => {
      const { runs } = (await server.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
      return runs.some((run) => run.groupTurnId && run.status === "canceled")
    })
    .toBe(true)
  expect(
    (await getHistory()).messages.filter((message) => persisted.messages.some((saved) => saved.id === message.id)),
  ).toEqual(persisted.messages)
})

test("private conversations still edit and select real branches", async ({ page, server }) => {
  test.setTimeout(120_000)
  const { bot } = (await server.api("/bots", "POST", {
    name: "Mapas",
    provider: seed.bots[0]?.provider,
    providerProfile: "demo",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  await saveSyntheticProfile(server, bot)
  const { threads } = (await server.api(`/bots/${bot.id}/threads`)) as { threads: Thread[] }
  const thread = threads[0]
  if (!thread) throw new Error("Missing synthetic private conversation")
  await server.setScenario({ deltas: ["Resposta de demonstração."] })
  await server.install(page)
  await page.goto(`${server.serverUrl}/?bot=${bot.id}&thread=${thread.id}`)
  const input = page.getByRole("textbox", { name: "Mensagem para Mapas" })
  const history = page.getByTestId("virtual-message-list")

  await input.fill("Pergunta original de demonstração.")
  await input.press("Enter")
  await expect(history.getByText("Resposta de demonstração.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Editar", exact: true }).click()
  await page.getByRole("textbox", { name: "Editar mensagem" }).fill("Pergunta corrigida de demonstração.")
  await page.getByRole("button", { name: "Salvar e enviar", exact: true }).click()

  const branches = page.getByRole("group", { name: "Ramificações da mensagem" })
  await expect(branches).toContainText("2/2")
  await expect(history.getByText("Pergunta corrigida de demonstração.", { exact: true })).toBeVisible()
  await expect(history.getByText("Pergunta original de demonstração.", { exact: true })).toHaveCount(0)
  await expect
    .poll(
      async () => {
        const { runs } = (await server.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
        return runs.length === 2 && runs.every((run) => run.status === "succeeded")
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await page.getByRole("button", { name: "Ramificação anterior" }).click()
  await expect(branches).toContainText("1/2")
  await expect(history.getByText("Pergunta original de demonstração.", { exact: true })).toBeVisible()
  await expect(history.getByText("Pergunta corrigida de demonstração.", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Próxima ramificação" }).click()
  await expect(branches).toContainText("2/2")
  await expect(history.getByText("Pergunta corrigida de demonstração.", { exact: true })).toBeVisible()
  const saved = (await server.api(`/threads/${thread.id}/messages?all=true`)) as { messages: Message[] }
  expect(saved.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
    "Pergunta original de demonstração.",
    "Pergunta corrigida de demonstração.",
  ])
})

const saveSyntheticProfile = async (server: ChannelServer, bot: Bot) =>
  server.restart(async (data) => {
    // Keep fake-provider authentication isolated from the user's host profile.
    const directory = join(data, "provider-profiles", "demo", bot.provider)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "auth.json"), "{}")
  })
