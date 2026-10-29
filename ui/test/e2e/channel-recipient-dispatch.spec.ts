import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test as base, expect } from "@playwright/test"
import type { Bot, BotGroup, Run, Thread } from "@touri/contracts"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createWorkGoldenServer } from "./work-golden-server"

type ChannelServer = Awaited<ReturnType<typeof createWorkGoldenServer>>
const test = base.extend<{ server: ChannelServer }>({
  // biome-ignore lint/correctness/noEmptyPattern: The fixture has no dependencies.
  server: async ({}, use) => {
    const server = await createWorkGoldenServer()
    await use(server)
    await server.dispose()
  },
})

test.afterEach(async ({ page }, info) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.evaluate(() => document.fonts.ready)
    const name = `channel-recipient-dispatch-${width}.png`
    const path = process.env.TOURI_E2E_EVIDENCE_DIR
      ? join(process.env.TOURI_E2E_EVIDENCE_DIR, name)
      : info.outputPath(name)
    await page.screenshot({ path, animations: "disabled" })
    await info.attach(name, { path, contentType: "image/png" })
  }
  await writeFile(info.outputPath("release-stream"), "release")
})

test("mentioned bots start together while their responses are held", async ({ page, server }, info) => {
  test.setTimeout(180_000)
  const bots = await Promise.all(
    ["Mapas", "Rotas"].map(async (name) => {
      const { bot } = (await server.api("/bots", "POST", {
        name,
        provider: seed.bots[0]?.provider,
        providerProfile: "demo",
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }
      return bot
    }),
  )
  await server.restart(async (data) => {
    const directory = join(data, "provider-profiles", "demo", bots[0]?.provider ?? "")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "auth.json"), "{}", { mode: 0o600 })
  })
  const { group, thread } = (await server.api("/groups", "POST", {
    name: "planejamento-demo",
    memberIds: bots.map((bot) => bot.id),
    coordinatorBotId: null,
  })) as { group: BotGroup; thread: Thread }
  await server.setScenario({
    deltas: ["Conferindo as opções de demonstração.", " Conferência concluída."],
    pauseAfterFirstDelta: info.outputPath("release-stream"),
    exitOnInterrupt: true,
  })
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
  const composer = page.getByRole("textbox", { name: /Mensagem (?:para |em #)planejamento-demo/ })
  const history = page.getByTestId("virtual-message-list")

  await composer.fill("Vamos conferir as opções de demonstração.")
  await composer.press("Enter")
  await expect(history.getByText("Vamos conferir as opções de demonstração.", { exact: true })).toBeVisible()
  const before = (await server.api(`/threads/${thread.id}/runs`)) as { runs: Run[] }
  expect(before.runs).toHaveLength(0)

  await composer.fill("@Mapas @Rotas confiram as opções de demonstração.")
  await composer.press("Enter")

  await expect(history.getByText("Conferindo as opções de demonstração.", { exact: true })).toHaveCount(2, {
    timeout: 30_000,
  })
  const { runs } = (await server.api(`/threads/${thread.id}/runs`)) as { runs: Run[] }
  const members = runs.filter((run) => run.groupTurnId)
  expect(members).toHaveLength(2)
  expect(members.every((run) => run.status === "running")).toBe(true)
  expect(new Set(members.map((run) => run.botId))).toEqual(new Set(bots.map((bot) => bot.id)))
})
