import { expect, test } from "@playwright/test"
import type { Thread, UiEvent } from "@touri/contracts"
import { getBrowserTurnMessage, getBrowserTurnRun } from "../browser-turn-fixture"

test.use({ reducedMotion: "reduce" })

const widths = [1440, 390]

widths.forEach((width) => {
  test(`canceled browser metadata and sidebar preview stay truthful at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/test/e2e/groups-harness.html")
    const composer = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    await expect(composer).toBeVisible({ timeout: 60_000 })
    const at = Date.now() + 1_000
    const message = getBrowserTurnMessage({ createdAt: at, updatedAt: at })
    const run = getBrowserTurnRun()

    await page.evaluate(
      ({ message, run }) => {
        const fixture = window as Window & {
          groupsQa?: { api: { emit: (event: UiEvent) => void; getState: () => { threads: Thread[] } } }
        }
        const api = fixture.groupsQa?.api
        if (!api) throw new Error("Missing synthetic conversation API")
        const thread = api.getState().threads.find((candidate) => candidate.id === message.threadId)
        if (!thread) throw new Error("Missing synthetic conversation")

        api.emit({ type: "run.updated", run })
        api.emit({ type: "message.created", message })
        api.emit({
          type: "thread.updated",
          thread: Object.assign({}, thread, { activeLeafId: message.id, updatedAt: message.updatedAt }),
        })
      },
      { message, run },
    )

    const reply = page.locator(`[data-message-id="${message.id}"]`)
    const meta = reply.locator(".message-meta")
    await expect(reply).toContainText(message.text)
    await expect(reply.locator(".browser-activity-card")).toHaveCount(1)
    await expect.soft(meta.getByRole("status")).toHaveText(["Cancelado por você"])
    await expect.soft(meta).not.toContainText("concluído")
    await expect.soft(reply.locator(".chat-terminal-status")).toHaveCount(1)

    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()

    const preview = page.locator('[data-bot-entry="bot-mark"] .bot-preview')
    await expect(preview).toBeVisible()
    await expect.soft(preview).toHaveText(message.text)
  })
})
