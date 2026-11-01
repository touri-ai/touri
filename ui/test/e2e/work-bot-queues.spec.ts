import { join } from "node:path"
import { expect as baseExpect, test } from "@playwright/test"
import type { Bot, BotGroup, Run, Thread } from "@touri/contracts"
import { openGlobalPage } from "./home-navigation"
import { createWorkGoldenServer } from "./work-golden-server"

const expect = baseExpect.configure({ timeout: 30_000 })
let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("real Work keeps three bot queues independent and body mentions are references", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const bots = await Promise.all(
    ["Lia", "Bia", "Nina"].map(async (name) => {
      const { bot } = (await current.api("/bots", "POST", {
        name,
        provider: "codex",
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }

      return bot
    }),
  )
  const [lia, bia, nina] = bots
  if (!lia || !bia || !nina) throw new Error("Missing synthetic teammates")
  const { thread } = (await current.api("/groups", "POST", {
    name: "Equipe de demonstração",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: bots.map((bot) => bot.id),
    coordinatorBotId: null,
  })) as { group: BotGroup; thread: Thread }
  const getRuns = async () => ((await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }).runs
  await current.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("button", { name: /^Equipe de demonstração/ }).click()
  const input = page.getByRole("textbox", { name: "Mensagem para Equipe de demonstração" })
  const send = async (text: string): Promise<Run> => {
    await input.fill(text)
    const accepted = page.waitForResponse(
      (response) => response.url().endsWith(`/threads/${thread.id}/messages`) && response.request().method() === "POST",
    )
    await input.press("Enter")
    const response = await accepted
    expect(response.ok()).toBe(true)
    const { run } = (await response.json()) as { run: Run | null }
    if (!run) throw new Error("Addressed request did not start")

    return run
  }
  const release = await current.holdReply("Análise de demonstração em andamento.")
  const first = await send("@Lia implemente com calma; depois peça à @Nina para validar")
  await expect(page.getByTestId("virtual-message-list")).toContainText("Análise de demonstração em andamento.")
  expect((await getRuns()).filter((run) => run.groupTurnId === first.id).map((run) => run.botId)).toEqual([lia.id])
  await current.setScenario({ deltas: ["Pedido independente concluído."] })
  const second = await send("@Bia confira o plano")
  const third = await send("@Nina valide agora")
  const ownNext = await send("@Lia próximo pedido")
  const shared = await send("@Lia @Bia revisem o próximo item")

  await expect
    .poll(async () =>
      (await getRuns()).filter((run) => [second.id, third.id].includes(run.id)).map((run) => run.status),
    )
    .toEqual(["succeeded", "succeeded"])
  await expect
    .poll(async () => (await getRuns()).find((run) => run.groupTurnId === shared.id && run.botId === bia.id)?.status)
    .toBe("succeeded")
  expect((await getRuns()).find((run) => run.id === first.id)?.status).toBe("running")
  expect((await getRuns()).find((run) => run.id === ownNext.id)?.status).toBe("queued")
  await openGlobalPage(page, "Trabalho")
  const queued = page.getByRole("region", { name: "Na fila", exact: true })
  await expect(queued.getByRole("article")).toHaveCount(2)
  await expect(queued.getByText("Lia", { exact: true })).toHaveCount(2)
  await expect(queued.getByText("Na fila deste bot · 2º de 2")).toBeVisible()

  await page.reload()
  await expect(queued.getByRole("article")).toHaveCount(2)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await expect(queued.getByText("Na fila deste bot · 2º de 2")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const name = `bot-queues-${width}.png`
    const path = process.env.TOURI_WORK_EVIDENCE_DIR
      ? join(process.env.TOURI_WORK_EVIDENCE_DIR, name)
      : testInfo.outputPath(name)
    await page.screenshot({ path, animations: "disabled" })
    await testInfo.attach(name, { path, contentType: "image/png" })
  }
  await release()
  await expect.poll(async () => (await getRuns()).find((run) => run.id === shared.id)?.status).toBe("succeeded")
  await expect(queued.getByRole("article")).toHaveCount(0)
  const completed = await getRuns()
  expect(completed.filter((run) => run.kind === "coordination")).toHaveLength(5)
  expect(
    completed
      .filter((run) => run.groupTurnId === shared.id)
      .map((run) => run.botId)
      .toSorted(),
  ).toEqual([lia.id, bia.id].toSorted())
})
