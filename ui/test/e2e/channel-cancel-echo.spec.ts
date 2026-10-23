import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import type { Run, UiEvent } from "@touri/contracts"
import type { ApiRequest } from "../../src/api/client"

test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`stopping a channel task leaves one stopped reply at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    const runs = await page.evaluate(async () => {
      const fixture = window as Window & {
        groupsQa?: {
          api: { request: ApiRequest; emit: (event: UiEvent) => void; getState: () => { messages: unknown[] } }
        }
      }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")
      const { group } = await api.request("POST /groups", {
        name: "Parar",
        color: "#2563eb",
        avatarShape: "classic-none",
        memberIds: ["bot-mark"],
        coordinatorBotId: null,
      })
      const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
      const threadId = threads[0]?.id
      if (!threadId) throw new Error("Missing channel conversation")
      const at = Date.now()
      const base = { threadId, kind: "text", source: "local", sender: { id: "bot-mark", name: "mark" } }
      const notice = { type: "notice", level: "info", code: "run_canceled", text: "Cancelado por você" }
      // Stored shape after Stop: the execution reply holds the text and command, the coordination only the notice.
      api.getState().messages.push(
        {
          ...base,
          id: "stop-request",
          runId: null,
          parentId: null,
          role: "user",
          status: "complete",
          text: "@mark espere",
          parts: [{ type: "text", text: "@mark espere" }],
          sender: null,
          createdAt: at,
          updatedAt: at,
        },
        {
          ...base,
          id: "stop-execution",
          runId: "run-execution",
          parentId: "stop-request",
          role: "assistant",
          status: "canceled",
          text: "Teste de parar iniciado",
          parts: [
            { type: "text", text: "Teste de parar iniciado" },
            {
              type: "command",
              callId: "call-wait",
              command: "python3 espera.py",
              cwd: "/demo",
              exitCode: null,
              outputTail: "",
            },
            notice,
          ],
          createdAt: at + 1,
          updatedAt: at + 1,
        },
        {
          ...base,
          id: "stop-coordination",
          runId: "run-coordination",
          parentId: "stop-execution",
          role: "assistant",
          status: "canceled",
          text: "",
          parts: [notice],
          createdAt: at + 2,
          updatedAt: at + 2,
        },
      )
      const getRun = (id: string, kind: Run["kind"], groupTurnId?: string): Run => ({
        id,
        kind,
        groupTurnId,
        threadId,
        botId: "bot-mark",
        provider: "codex",
        trigger: "user",
        requestMessageId: "stop-request",
        replyMessageId: kind === "coordination" ? "stop-coordination" : "stop-execution",
        externalTurnId: null,
        status: "canceled",
        errorClass: "canceled",
        errorMessage: null,
        usage: null,
        routineRunId: null,
        queuedAt: at,
        startedAt: at,
        finishedAt: at + 2,
      })
      return [getRun("run-coordination", "coordination"), getRun("run-execution", "execution", "run-coordination")]
    })
    if (viewport.width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("tab", { name: /^Work/ }).click()
    await page
      .getByRole("region", { name: "Canais", exact: true })
      .getByRole("button", { name: /^Parar/ })
      .click()
    if (await page.getByRole("dialog", { name: "Barra lateral", exact: true }).isVisible())
      await page.keyboard.press("Escape")
    await expect(page.getByRole("textbox", { name: "Mensagem para Parar", exact: true })).toBeVisible()
    // The synthetic runs are not in the mock store; hydrate the selected Work workspace through its event stream.
    await page.evaluate((runs) => {
      const fixture = window as Window & { groupsQa?: { api: { emit: (event: UiEvent) => void } } }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")

      runs.forEach((run) => {
        api.emit({ type: "run.updated", run })
      })
    }, runs)

    const replies = page.locator(".message-scroll [data-message-id]")
    await expect(page.locator('[data-message-id="stop-execution"]')).toContainText("Teste de parar iniciado")
    await expect(page.locator('[data-message-id="stop-execution"]')).toContainText("Cancelado por você")
    await expect(page.locator('[data-message-id="stop-coordination"]')).toHaveCount(0)
    await expect(replies.filter({ hasText: "Cancelado por você" })).toHaveCount(1)
    const violations = await new AxeBuilder({ page })
      .include(".message-scroll")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()

    expect(violations.violations).toEqual([])
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({ path: `${process.env.TOURI_SCREENSHOT_DIR}/channel-stop-${viewport.width}.png` })
  })
}
