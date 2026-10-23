import { spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("async workspace previews render after restart at desktop and phone widths", async ({ page }, info) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Brisa",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  expect(bot.mainThreadId).toBeTruthy()
  await current.restart(async (data) => {
    const child = spawn("bun", ["sidecar/test/fakes/workspace-previews.ts", data, bot.mainThreadId ?? ""], {
      cwd: join(import.meta.dirname, "../../.."),
      stdio: "inherit",
      timeout: 30000,
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    expect(code).toBe(0)
  })
  await current.install(page)
  await page.goto(current.serverUrl)
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR ?? info.outputDir
  await mkdir(directory, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const entry = page.locator(`[data-bot-entry="${bot.id}"]`)
    await expect(entry).toContainText("O caderno fictício está pronto.")
    const path = join(directory, `workspace-preview-${width}.png`)
    await page.screenshot({ path, animations: "disabled", mask: [page.locator(".composer-model")] })
    await info.attach(`preview-${width}`, { path, contentType: "image/png" })
  }
})
