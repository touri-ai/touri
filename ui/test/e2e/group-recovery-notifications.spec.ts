import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, BotGroup, RecoveryTask, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("linked interruptions have one real attention notice and retain both journals", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Brisa QA",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { thread, group } = (await current.api("/groups", "POST", {
    name: "Projeto QA",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })) as { thread: Thread; group: BotGroup }
  await current.restart(async (data) => {
    const child = spawn(
      "bun",
      [
        "sidecar/test/fakes/group-recovery-notifications.ts",
        data,
        JSON.stringify({ threadId: thread.id, groupId: group.id, botId: bot.id }),
      ],
      { cwd: join(import.meta.dirname, "../../.."), stdio: "inherit", timeout: 30_000 },
    )
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    expect(code).toBe(0)
  })
  const { tasks } = (await current.api("/recovery")) as { tasks: RecoveryTask[] }
  expect(tasks.filter((task) => task.notification.resolvedAt === null)).toHaveLength(1)
  expect(tasks[0]?.effects.filter((effect) => effect.acknowledgeKey)).toHaveLength(2)
  await current.install(page)
  await page.goto(current.serverUrl)
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações,/ }).click()
    await expect(page.locator(".sidebar-needs-you-count")).toHaveCount(0)
    const bell = page.getByRole("region", { name: "Central de notificações" })
    await expect(bell.locator(".notification-row:not(.resolved)")).toHaveCount(1)
    const bellPath = join(directory, `logical-recovery-bell-${width}.png`)
    await page.screenshot({ path: bellPath })
    await info.attach(`bell-${width}`, { path: bellPath, contentType: "image/png" })
    await bell.getByRole("button", { name: "Tarefas interrompidas", exact: true }).click()
    const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await expect(center.getByTestId("interrupted-task")).toHaveCount(1)
    await center.getByRole("button", { name: /Ver ações realizadas/ }).click()
    await expect(center.getByText("Prévia da coordenação", { exact: true })).toBeVisible()
    await expect(center.getByText("Prévia do membro", { exact: true })).toBeVisible()
    await expect(center.getByRole("checkbox")).toHaveCount(1)
    await center.getByRole("checkbox").check()
    await expect(center.getByRole("button", { name: "Descartar", exact: true })).toBeEnabled()
    await center.getByRole("checkbox").uncheck()
    await expect(center.getByRole("button", { name: "Descartar", exact: true })).toBeDisabled()
    const centerPath = join(directory, `logical-recovery-effects-${width}.png`)
    await page.screenshot({ path: centerPath })
    await info.attach(`effects-${width}`, { path: centerPath, contentType: "image/png" })
    await page.keyboard.press("Escape")
  }
})
