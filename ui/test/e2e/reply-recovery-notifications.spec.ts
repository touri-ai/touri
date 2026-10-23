import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, NotificationRecord, RecoveryTask, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("ordinary channel messages preserve recovery attention and uncertain effects", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Brisa QA",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { thread } = (await current.api("/groups", "POST", {
    name: "Caderno QA",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: bot.id,
  })) as { thread: Thread }
  await current.restart(async (data) => {
    const child = spawn(
      "bun",
      [
        "sidecar/test/fakes/reply-recovery-notifications.ts",
        data,
        JSON.stringify({ threadId: thread.id, botId: bot.id }),
      ],
      { cwd: join(import.meta.dirname, "../../.."), stdio: "inherit", timeout: 30_000 },
    )
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    expect(code).toBe(0)
  })
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(current.serverUrl)
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const result = (await current.api(`/threads/${thread.id}/messages`, "POST", {
      text: `Anotação fictícia do caderno ${width}.`,
    })) as { run: unknown }
    expect(result.run).toBeNull()
    const { notifications } = (await current.api("/notifications")) as { notifications: NotificationRecord[] }
    const original = notifications.find((item) => item.requestId === "recovery:run:interrupted-reply")
    const routine = notifications.find((item) => item.requestId === "routine:reply-failure")
    expect(original?.resolvedAt).toBeNull()
    expect(routine?.resolvedAt).toBeNull()
    const { tasks } = (await current.api("/recovery")) as { tasks: RecoveryTask[] }
    expect(tasks.find((task) => task.runId === "interrupted-reply")?.notification.resolvedAt).toBeNull()
    expect(tasks[0]?.effects.some((effect) => effect.acknowledgeKey)).toBe(true)
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações,/ }).click()
    const bell = page.getByRole("region", { name: "Central de notificações" })
    await expect(bell.locator(".notification-row:not(.resolved)")).toHaveCount(2)
    const bellPath = join(directory, `reply-recovery-bell-${width}.png`)
    await page.screenshot({ path: bellPath, animations: "disabled" })
    await info.attach(`bell-${width}`, { path: bellPath, contentType: "image/png" })
    await bell.getByRole("button", { name: "Tarefas interrompidas", exact: true }).click()
    const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await expect(center.getByTestId("interrupted-task")).toHaveCount(1)
    await center.getByRole("button", { name: /Ver ações realizadas/ }).click()
    await expect(center.getByText("Prévia fictícia pendente de revisão", { exact: true })).toBeVisible()
    await expect(center.getByRole("button", { name: "Descartar", exact: true })).toBeDisabled()
    const effectsPath = join(directory, `reply-recovery-effects-${width}.png`)
    await page.screenshot({ path: effectsPath, animations: "disabled" })
    await info.attach(`effects-${width}`, { path: effectsPath, contentType: "image/png" })
    await page.keyboard.press("Escape")
  }
})
