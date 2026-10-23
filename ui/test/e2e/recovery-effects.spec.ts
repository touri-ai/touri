import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { AppSettings, Bot, Message, RecoveryTask, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("channel recovery counts a mirrored command once after restart", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { settings: initialSettings } = (await current.api("/settings", "PATCH", {
    resumeInterruptedTurns: false,
    nativeNotifications: false,
  })) as { settings: AppSettings }
  const bots = await Promise.all(
    ["Brisa", "Oceano"].map(async (name) => {
      const { bot } = (await current.api("/bots", "POST", {
        name,
        provider: initialSettings.defaultProvider,
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }
      return bot
    }),
  )
  const { thread } = (await current.api("/groups", "POST", {
    name: "Roteiro de demonstração",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: bots.map((bot) => bot.id),
    coordinatorBotId: null,
  })) as { thread: Thread }
  await current.setScenario({
    events: [{ type: "command", callId: "synthetic-wait", command: "sleep 90", output: "" }],
    slowMs: 90_000,
  })
  const { run } = (await current.api(`/threads/${thread.id}/messages`, "POST", {
    text: "@Brisa confira o roteiro fictício e aguarde.",
  })) as { run: Run }
  const getRuns = async () => {
    const { runs } = (await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
    return runs
  }
  await expect
    .poll(
      async () =>
        (await getRuns()).filter((candidate) => candidate.groupTurnId === run.id && candidate.status === "running")
          .length,
      { timeout: 30_000 },
    )
    .toBe(1)
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: "Roteiro de demonstração", exact: true })
    .first()
    .click()
  const composer = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Roteiro de demonstração/ })
  const draft = "Anotação fictícia: revisar o roteiro depois da interrupção."
  await composer.fill(draft)

  await expect
    .poll(async () => {
      const { messages } = (await current.api(`/threads/${thread.id}/messages`)) as { messages: Message[] }
      return messages.some((message) => message.parts.some((part) => part.type === "command"))
    })
    .toBe(true)
  await current.restart()
  const { settings } = (await current.api("/settings")) as { settings: { resumeInterruptedTurns: boolean } }
  expect(settings.resumeInterruptedTurns).toBe(false)
  await expect
    .poll(async () => (await getRuns()).filter((candidate) => candidate.status === "interrupted").length)
    .toBe(2)
  const { tasks } = (await current.api("/recovery")) as { tasks: RecoveryTask[] }
  expect(tasks.filter((task) => task.notification.resolvedAt === null)).toMatchObject([
    { runId: run.id, notification: { threadId: thread.id } },
  ])
  expect(tasks[0]?.effects.filter((effect) => effect.description === "sleep 90")).toHaveLength(1)
  expect(await getRuns()).toHaveLength(2)
  const { messages } = (await current.api(`/threads/${thread.id}/messages`)) as { messages: Message[] }
  expect(messages.some((message) => message.id === run.requestMessageId)).toBe(true)
  await expect(composer).toHaveValue(draft)
  await expect(page.getByText("Reconectando…", { exact: true })).toHaveCount(0, { timeout: 30_000 })
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações,/ }).click()
    const bell = page.getByRole("region", { name: "Central de notificações" })
    await expect(bell.locator('.notification-row[data-kind="turn-failed"]:not(.resolved)')).toHaveCount(1)
    const bellPath = join(directory, `recovery-effects-bell-${width}.png`)
    await page.screenshot({ path: bellPath, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(`bell-${width}`, { path: bellPath, contentType: "image/png" })
    await bell.getByRole("button", { name: "Tarefas interrompidas", exact: true }).click()
    const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await expect(center.getByTestId("interrupted-task")).toHaveCount(1)
    await expect(center.getByRole("button", { name: "Retomar tarefa", exact: true })).toBeEnabled()
    await center.getByRole("button", { name: "Ver ações realizadas (1)", exact: true }).click()
    await expect(center.getByText("sleep 90", { exact: true })).toHaveCount(1)
    const centerPath = join(directory, `recovery-effects-task-${width}.png`)
    await page.screenshot({ path: centerPath, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(`task-${width}`, { path: centerPath, contentType: "image/png" })
    await page.keyboard.press("Escape")
  }
})
