import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, NotificationRecord, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("restart preserves Brisa attention after independent Oceano success", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const createBot = async (name: string) =>
    (
      (await current.api("/bots", "POST", {
        name,
        provider: "codex",
        access: "read-only",
        approvals: "on-request",
      })) as {
        bot: Bot
      }
    ).bot
  const brisa = await createBot("Brisa")
  const oceano = await createBot("Oceano")
  const { thread } = (await current.api("/groups", "POST", {
    name: "Caderno fictício",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [brisa.id, oceano.id],
    coordinatorBotId: brisa.id,
  })) as { thread: Thread }
  const seed = (phase: string) => async (data: string) => {
    const child = spawn(
      "bun",
      [
        "sidecar/test/fakes/notification-bot-identity.ts",
        data,
        JSON.stringify({
          threadId: thread.id,
          failedBotId: brisa.id,
          successfulBotId: oceano.id,
        }),
        phase,
      ],
      { cwd: join(import.meta.dirname, "../../.."), stdio: "inherit", timeout: 30_000 },
    )
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    expect(code).toBe(0)
  }
  await current.restart(seed("failure"))
  await current.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(current.serverUrl)
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  const getFailure = async () => {
    const { notifications } = (await current.api("/notifications")) as { notifications: NotificationRecord[] }
    return notifications.find((item) => item.requestId === "recovery:run:brisa-failure")
  }
  const original = await getFailure()
  expect(original?.resolvedAt).toBeNull()

  await current.restart(seed("success"))
  await page.reload()

  await expect.poll(async () => (await getFailure())?.resolvedAt).toBeNull()
  expect((await getFailure())?.id).toBe(original?.id)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /Notificações,/ }).click()
    const bell = page.getByRole("region", { name: "Central de notificações" })
    await expect(bell.locator(".notification-row:not(.resolved)")).toHaveCount(1)
    const bellPath = join(directory, `bot-identity-bell-${width}.png`)
    await page.screenshot({ path: bellPath, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(`bell-${width}`, { path: bellPath, contentType: "image/png" })
    await bell.getByRole("button", { name: "Tarefas interrompidas", exact: true }).click()
    const center = page.getByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await expect(center.getByTestId("interrupted-task")).toHaveCount(1)
    const tasksPath = join(directory, `bot-identity-tasks-${width}.png`)
    await page.screenshot({ path: tasksPath, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(`tasks-${width}`, { path: tasksPath, contentType: "image/png" })
    await page.keyboard.press("Escape")
  }
})
