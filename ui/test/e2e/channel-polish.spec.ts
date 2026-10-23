import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, BotGroup, RoutineRun, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("channel polish keeps identities, messages and the member panel clear", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "mapas",
    roleLine: "Organiza os mapas de demonstração",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { group, thread } = (await current.api("/groups", "POST", {
    name: "fazendomapas",
    color: "#16a34a",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })) as { group: BotGroup; thread: Thread }
  await current.api(`/groups/${group.id}/threads`, "POST", { title: group.name })
  await current.setScenario({ deltas: ["Mapas de demonstração conferidos. Podemos continuar."] })
  await current.api(`/threads/${thread.id}/messages`, "POST", { text: "@mapas confira os mapas de demonstração." })
  await expect
    .poll(async () => {
      const { runs } = (await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
      return runs.some((run) => run.groupTurnId && run.status === "succeeded")
    })
    .toBe(true)
  const { routine } = (await current.api("/routines", "POST", {
    botId: bot.id,
    name: "slot manha",
    prompt: "Confira os mapas de demonstração.",
    cron: "0 8 * * *",
    timezone: "UTC",
    enabled: false,
    continuity: "new-thread",
    groupId: group.id,
    resultsThreadId: null,
    timeoutMinutes: 10,
    overlap: "skip",
    catchUpMinutes: 0,
  })) as { routine: { id: string } }
  const { routineRun } = (await current.api(`/routines/${routine.id}/run`, "POST", {})) as { routineRun: RoutineRun }
  await expect
    .poll(async () => {
      const { runs } = (await current.api(`/threads/${routineRun.threadId}/runs?all=true`)) as { runs: Run[] }
      return runs.some((run) => run.groupTurnId && run.status === "succeeded")
    })
    .toBe(true)
  for (const index of Array.from({ length: 8 }, (_, index) => index)) {
    await current.api(`/threads/${thread.id}/messages`, "POST", {
      text: `Anotação de demonstração ${index + 1}. ${"A equipe vai conferir o roteiro e os mapas. ".repeat(8)}`,
    })
  }
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: group.name, exact: true })
    .first()
    .click()
  const input = page.getByRole("textbox", { name: /Mensagem (?:para |em #)fazendomapas/ })
  await expect(input).toBeVisible()
  const phase = process.env.TOURI_CHANNEL_POLISH_PHASE ?? "after"
  const directory = process.env.TOURI_CHANNEL_POLISH_EVIDENCE_DIR ?? testInfo.outputDir
  await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const messages = page.getByTestId("virtual-message-list")
    await messages.evaluate((element) => element.scrollTo(0, element.scrollHeight / 3))
    await expect(page.getByRole("button", { name: "Voltar ao fim", exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const chatPath = join(directory, `${phase}-chat-${width}.png`)
    await page.screenshot({ path: chatPath, animations: "disabled" })
    await testInfo.attach(`${phase}-chat-${width}`, { path: chatPath, contentType: "image/png" })
    await page.getByRole("button", { name: /^Membros do canal:/ }).click()
    const panel = page.getByRole("complementary", { name: "Painel do canal fazendomapas", exact: true })
    await expect(panel.getByRole("button", { name: "Editar canal", exact: true })).toBeVisible()
    const panelPath = join(directory, `${phase}-panel-${width}.png`)
    await page.screenshot({ path: panelPath, animations: "disabled" })
    await testInfo.attach(`${phase}-panel-${width}`, { path: panelPath, contentType: "image/png" })
    if (phase !== "before") {
      await expect(panel.getByText("Resultados do turno", { exact: true })).toHaveCount(0)
      await expect(panel.locator(".group-member-result, .group-board")).toHaveCount(0)
      await expect(panel.getByText("Pessoa demo", { exact: true })).toBeVisible()
      await expect(panel.getByText("Pessoa", { exact: true })).toHaveCount(0)
      await expect(panel.getByText("Organiza os mapas de demonstração")).toHaveCount(0)
      const nameBounds = await panel.getByText("mapas", { exact: true }).boundingBox()
      const statusBounds = await panel.getByText("Disponível", { exact: true }).boundingBox()
      if (!nameBounds || !statusBounds) throw new Error("Missing member status layout")

      expect(statusBounds.y).toBeGreaterThanOrEqual(nameBounds.y + nameBounds.height)
      await expect(panel.locator(".group-status-members .tb-avatar")).toHaveCount(2)
      await expect(page.locator(".channel-member-avatars .tb-avatar")).toHaveCount(2)
      const avatarIdentity = (element: Element) => [
        element.getAttribute("data-avatar-shape"),
        element.getAttribute("data-avatar-head"),
        element.getAttribute("style")?.match(/--avatar-color: ([^;]+)/)?.[1],
      ]
      const panelAvatar = await panel.locator('[data-bot-id="owner"]').evaluate(avatarIdentity)
      const messageAvatar = await messages.locator('[data-bot-id="owner"]').first().evaluate(avatarIdentity)
      const headerAvatar = await page.locator('.channel-member-avatars [data-bot-id="owner"]').evaluate(avatarIdentity)

      expect(panelAvatar).toEqual(messageAvatar)
      expect(headerAvatar).toEqual(messageAvatar)
      expect(
        await panel
          .locator("*")
          .evaluateAll((elements) =>
            elements
              .filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
              .map((element) => element.className),
          ),
      ).toEqual([])
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
    await panel.getByRole("button", { name: "Fechar painel do canal", exact: true }).click()
    if (phase !== "before") {
      const scrollBounds = await messages.boundingBox()
      const controlBounds = await page.getByRole("button", { name: "Voltar ao fim", exact: true }).boundingBox()
      if (!scrollBounds || !controlBounds) throw new Error("Missing scroll layout")

      expect(scrollBounds.y + scrollBounds.height).toBeLessThanOrEqual(controlBounds.y)
      expect(
        await messages.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
      ).toBeGreaterThanOrEqual(64)
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "Voltar ao fim", exact: true }).click()
  await input.fill("Mensagem de demonstração entregue.")
  await input.press("Enter")
  await expect(
    page.getByTestId("virtual-message-list").getByText("Mensagem de demonstração entregue.", { exact: true }),
  ).toBeVisible()
  await expect(page.locator(".delivery-state").filter({ hasText: "Entregue" })).toHaveCount(0)
  await expect(input).toHaveAttribute("placeholder", "Mensagem em #fazendomapas")
  await expect(page.locator(".group-thread-list button").filter({ hasText: /^fazendomapas$/ })).toHaveCount(0)
  await expect(page.locator(".group-thread-list")).toContainText(/slot manha · \d{1,2} [a-z]{3}/)
  await expect(page.locator(".sidebar-footer .user-chip strong")).toHaveText("Pessoa demo")
})
