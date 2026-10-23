import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("restart preserves both requests to one channel member in order", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Aurora QA",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { thread } = (await current.api("/groups", "POST", {
    name: "Retomada QA",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })) as { thread: Thread }
  await current.install(page)
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: /^Retomada QA/ })
    .first()
    .click()
  const composer = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Retomada QA/ })
  const getRuns = async () => ((await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }).runs
  const capture = async (phase: string) => {
    const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const path = join(directory, `group-restart-${phase}-${width}.png`)
      await page.screenshot({ path, animations: "disabled" })
      await info.attach(`${phase}-${width}`, { path, contentType: "image/png" })
    }
  }
  await current.setScenario({ deltas: ["Primeiro pedido em andamento."], slowMs: 90_000 })
  await composer.fill("@Aurora QA confira o primeiro pedido.")
  await composer.press("Enter")
  await expect(
    page.getByTestId("virtual-message-list").getByText("Primeiro pedido em andamento.", { exact: true }),
  ).toBeVisible({ timeout: 30_000 })
  await composer.fill("@Aurora QA confira o segundo pedido depois do primeiro.")
  await composer.press("Enter")
  await expect
    .poll(async () => (await getRuns()).filter((run) => run.kind === "coordination" && run.status === "queued").length)
    .toBe(1)
  const first = (await getRuns()).find((run) => run.kind === "coordination" && run.status === "running")
  expect(first).toBeDefined()
  await capture("before")

  await current.setScenario({ deltas: ["Pedido conferido e concluído."] })
  await current.restart()
  await page.reload()
  await expect
    .poll(
      async () => (await getRuns()).filter((run) => run.kind === "coordination" && run.status === "succeeded").length,
      { timeout: 60_000 },
    )
    .toBe(2)
  const runs = await getRuns()
  const resumed = runs.find(
    (run) =>
      run.kind === "coordination" && run.requestMessageId === first?.requestMessageId && run.status === "succeeded",
  )
  expect(resumed?.automaticResumeFromRunId).toBe(first?.id)
  const second = runs.find((run) => run.kind === "coordination" && run.requestMessageId !== first?.requestMessageId)
  expect(second?.startedAt).toBeGreaterThanOrEqual(resumed?.finishedAt ?? Infinity)
  await expect(page.getByRole("button", { name: "Retomar tarefa", exact: true })).toHaveCount(0)
  await expect(
    page.getByTestId("virtual-message-list").getByText("Pedido conferido e concluído.", { exact: true }),
  ).toHaveCount(2)
  await capture("after")
})
