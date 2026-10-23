import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, BotGroup, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

test.use({ channel: "chromium", reducedMotion: "reduce" })
test.setTimeout(180_000)
const cleanups = new Set<() => Promise<void>>()
test.afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

test("a reloaded channel keeps its original recovery card and retries only the new failure", async ({
  page,
}, testInfo) => {
  const server = await createWorkGoldenServer()
  cleanups.add(server.dispose)
  const { bot } = (await server.api("/bots", "POST", {
    name: "Lia",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { thread } = (await server.api("/groups", "POST", {
    name: "Planejamento",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })) as { group: BotGroup; thread: Thread }
  await server.setScenario({ deltas: ["Trecho inicial do relatório."], slowMs: 60_000 })
  await server.install(page)
  await page.goto(server.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: /^Planejamento/ })
    .click()
  const conversation = page.getByTestId("virtual-message-list")
  const input = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Planejamento/ })
  const capture = async (label: string) => {
    const directory = process.env.AUTOMATIC_RESUME_RELOAD_CAPTURE_DIR
    if (directory) await mkdir(directory, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const filename = `${label}-${width}.png`
      await page.screenshot({ path: directory ? join(directory, filename) : testInfo.outputPath(filename) })
    }
  }
  const send = async (text: string) => {
    await input.fill(text)
    await input.press("Enter")
  }

  await send("@Lia termine o relatório.")
  await expect(conversation.getByText("Trecho inicial do relatório.", { exact: true })).toBeVisible({ timeout: 30_000 })
  const original = conversation.locator(".message-assistant").filter({ hasText: "Trecho inicial do relatório." })
  const originalId = await original.getAttribute("data-message-id")
  if (!originalId) throw new Error("Missing original response card")
  await capture("reload-before")
  await server.setScenario({ deltas: ["Relatório retomado e concluído."] })
  await server.restart()
  await page.reload()
  await expect
    .poll(
      async () => {
        const { runs } = (await server.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
        return runs.filter((run) => !run.groupTurnId).some((run) => run.status === "succeeded")
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const recovered = conversation.locator(`[data-message-id="${originalId}"]`)

  await expect(recovered).toContainText("Trecho inicial do relatório.")
  await expect(recovered).toContainText("Relatório retomado e concluído.")
  expect(await recovered.innerText()).toMatch(/Trecho inicial do relatório\.[\s\S]*Relatório retomado e concluído\./)
  await expect(conversation.getByRole("alert")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(0)
  await capture("reload-after")

  await server.setScenario({ deltas: [] })
  await send("@Lia confira uma resposta vazia.")
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(1)
  await capture("reload-new-failure")
  await server.setScenario({ deltas: ["Resposta conferida após nova tentativa."] })
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).click()
  await expect(conversation.getByText("Resposta conferida após nova tentativa.", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(0)
  await capture("reload-new-retry")
})
