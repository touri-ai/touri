import { expect } from "@playwright/test"
import type { ApiRequest } from "../../src/api/client"
import { test } from "./production-fixture"

test.use({ channel: "chromium", reducedMotion: "reduce" })

const request =
  "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas."

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]
  .flatMap((viewport) => [
    { ...viewport, draft: "" },
    { ...viewport, draft: "@marketing confira o relatório." },
  ])
  .flatMap((viewport) =>
    ["dark", "light"].map((colorScheme) => ({
      width: viewport.width,
      height: viewport.height,
      draft: viewport.draft,
      colorScheme,
    })),
  )) {
  test(`resuming a channel task calls the interrupted bot at ${viewport.width}px (${viewport.draft ? "existing draft" : "empty draft"}) in ${viewport.colorScheme}`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(viewport)
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), viewport.colorScheme)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    await page.evaluate(async (draft) => {
      const fixture = window as Window & {
        groupsQa?: {
          api: {
            request: ApiRequest
            getState: () => { messages: unknown[] }
            notify: (input: Record<string, unknown>) => unknown
          }
        }
      }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")
      const { group } = await api.request("POST /groups", {
        name: "Viagem",
        color: "#2563eb",
        avatarShape: "classic-none",
        memberIds: ["bot-mark", "bot-onb"],
        coordinatorBotId: null,
      })
      const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
      const threadId = threads[0]?.id
      if (!threadId) throw new Error("Missing channel conversation")
      if (draft) localStorage.setItem(`touri.composer-draft.v1:${threadId}`, draft)
      const at = Date.now()
      const base = { threadId, kind: "text", runId: null, source: "local" }
      // mark was interrupted by a restart; onb answered an independent request afterwards.
      api.getState().messages.push(
        {
          ...base,
          id: "resume-request",
          parentId: null,
          role: "user",
          status: "complete",
          text: "@mark espere 90 segundos",
          parts: [{ type: "text", text: "@mark espere 90 segundos" }],
          sender: null,
          createdAt: at,
          updatedAt: at,
        },
        {
          ...base,
          id: "resume-interrupted",
          parentId: "resume-request",
          role: "assistant",
          status: "failed",
          text: "Comecei a espera.",
          parts: [
            { type: "text", text: "Comecei a espera." },
            {
              type: "command",
              callId: "call-wait",
              command: "python3 espera.py",
              cwd: "/demo",
              exitCode: null,
              outputTail: "",
            },
            { type: "notice", level: "error", code: "app_restart", text: "app_restart: touri restarted" },
          ],
          sender: { id: "bot-mark", name: "mark" },
          createdAt: at + 1,
          updatedAt: at + 1,
        },
        {
          ...base,
          id: "resume-other",
          parentId: "resume-interrupted",
          role: "assistant",
          status: "complete",
          text: "Olá! Estou disponível.",
          parts: [{ type: "text", text: "Olá! Estou disponível." }],
          sender: { id: "bot-onb", name: "onb" },
          createdAt: at + 2,
          updatedAt: at + 2,
        },
      )
      api.notify({
        kind: "turn-failed",
        botId: "bot-mark",
        threadId,
        title: "Tarefas interrompidas",
        body: "app_restart: touri restarted",
      })
    }, viewport.draft)
    if (viewport.width < 500) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("button", { name: /^Notificações/ }).click()
    const center = page.getByRole("region", { name: "Central de notificações" })
    await center.getByRole("button", { name: "Retomar tarefa", exact: true }).first().click()

    const input = page.getByRole("textbox", { name: "Mensagem para Viagem", exact: true })
    await expect(input).toBeVisible()

    // Capture the loaded conversation before checking the baseline's obstructing drawer.
    if (process.env.TOURI_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.TOURI_SCREENSHOT_DIR}/channel-resume-${viewport.colorScheme}-${viewport.width}-${viewport.draft ? "existing" : "empty"}.png`,
        animations: "disabled",
      })

    await expect(page.getByRole("dialog", { name: "Barra lateral", exact: true })).not.toBeVisible()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(`@mark ${request}${viewport.draft ? `\n\n${viewport.draft}` : ""}`)
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
  })
}
