import { join } from "node:path"
import { expect as baseExpect, test } from "@playwright/test"
import type { Bot, BotGroup, Message, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

const expect = baseExpect.configure({ timeout: 30_000 })
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 })

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("Work channel golden path survives long turns and a server restart", async ({ page }, testInfo) => {
  test.setTimeout(600_000)
  const current = await createWorkGoldenServer()
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Lia",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  await current.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("button", { name: "Novo canal", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Criar canal", exact: true })
  await dialog.getByLabel("Nome do canal").fill("Planejamento")
  await dialog.getByRole("checkbox", { name: "Lia", exact: true }).check()
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/groups") && response.request().method() === "POST",
  )
  await dialog.getByRole("button", { name: "Criar canal", exact: true }).click()
  const { group, thread } = (await (await created).json()) as { group: BotGroup; thread: Thread }
  const input = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Planejamento/ })
  const capture = async (name: string) => {
    const path = process.env.TOURI_WORK_EVIDENCE_DIR
      ? join(process.env.TOURI_WORK_EVIDENCE_DIR, `${name}.png`)
      : testInfo.outputPath(`${name}.png`)
    await page.screenshot({ path })
    await testInfo.attach(name, { path, contentType: "image/png" })
  }
  const send = async (text: string) => {
    await input.fill(text)
    const accepted = page.waitForResponse(
      (response) => /\/threads\/[^/]+\/messages$/.test(response.url()) && response.request().method() === "POST",
    )
    await input.press("Enter")
    expect((await accepted).ok()).toBe(true)
  }
  const getRuns = async (): Promise<Run[]> =>
    ((await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }).runs
  const waitForSuccess = async () =>
    expect
      .poll(
        async () => {
          const runs = await getRuns()
          return runs
            .filter((run) => !run.groupTurnId)
            .reduce<Run | undefined>(
              (latest, run) => (!latest || run.queuedAt > latest.queuedAt ? run : latest),
              undefined,
            )?.status
        },
        { timeout: 220_000 },
      )
      .toBe("succeeded")

  await expect(input).toBeVisible()
  await capture("01-created-channel")
  await send("Bom dia, equipe.")
  await expect(page.getByText("Bom dia, equipe.", { exact: true })).toBeVisible()
  expect(await getRuns()).toHaveLength(0)
  await capture("02-plain-message")
  await send("@Lia confira o plano.")
  await waitForSuccess()
  await expect(page.getByText("Plano conferido. Podemos continuar.", { exact: true })).toBeVisible()
  expect((await getRuns()).filter((run) => run.groupTurnId)).toHaveLength(1)
  await capture("03-channel-reply")
  await page.getByRole("button", { name: /^Membros do canal:/ }).click()
  const panel = page.getByRole("complementary", { name: "Painel do canal Planejamento", exact: true })
  await expect(panel.getByText("Resultados do turno")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Editar canal", exact: true })).toBeVisible()
  await capture("04-members")
  await panel.getByRole("button", { name: "Fechar painel do canal", exact: true }).click()

  await current.setScenario({ deltas: ["Resumo da manhã concluído."] })
  const { routine } = (await current.api("/routines", "POST", {
    botId: bot.id,
    name: "Manhã",
    prompt: "Resuma o plano.",
    cron: "0 8 * * *",
    timezone: "UTC",
    enabled: false,
    continuity: "new-thread",
    groupId: group.id,
    resultsThreadId: null,
    timeoutMinutes: 10,
    overlap: "skip",
    catchUpMinutes: 0,
  })) as { routine: { id: string } }
  await current.api(`/routines/${routine.id}/run`, "POST", {})
  const cards = page.getByRole("region", { name: "Conversas do canal", exact: true })
  await expect(cards.getByText("Resumo da manhã concluído.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await capture("05-routine-in-channel")
  await cards.getByRole("button").click()
  await expect(page.getByText("Resumo da manhã concluído.", { exact: true }).first()).toBeVisible()
  await capture("06-open-routine")
  await page
    .getByRole("region", { name: "Canais", exact: true })
    .getByRole("button", { name: /^Planejamento/ })
    .first()
    .click()

  await current.setScenario({ deltas: ["Tarefa longa concluída."], slowMs: 181_000 })
  const started = Date.now()
  await send("@Lia faça a verificação longa.")
  await waitForSuccess()
  expect(Date.now() - started).toBeGreaterThan(180_000)
  await expect(page.getByText("Tarefa longa concluída.", { exact: true })).toBeVisible()
  await capture("07-long-turn-complete")

  await current.setScenario({ deltas: ["Verificação em andamento…"], slowMs: 181_000 })
  await send("@Lia continue após uma interrupção.")
  await expect(page.getByText("Verificação em andamento…", { exact: true })).toBeVisible({ timeout: 30_000 })
  await capture("08-before-restart")
  await current.setScenario({ deltas: ["Verificação retomada e concluída."] })
  await current.restart()
  await page.reload()
  await waitForSuccess()
  await expect(page.getByText("Verificação retomada e concluída.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Retomar tarefa", exact: true })).toHaveCount(0)
  await capture("09-auto-resumed")
  await current.setScenario({ deltas: [] })
  await send("@Lia confira uma resposta vazia.")
  await expect(page.getByText("O bot terminou sem responder. Tente novamente.", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  })
  await capture("10-empty-answer-fails")
  await current.setScenario({ deltas: ["Resposta conferida após tentar novamente."] })
  await page.getByRole("button", { name: "Tentar novamente", exact: true }).first().click()
  await waitForSuccess()
  await expect(page.getByText("Resposta conferida após tentar novamente.", { exact: true })).toBeVisible()
  const { messages } = (await current.api(`/threads/${thread.id}/messages`)) as { messages: Message[] }
  expect(
    messages
      .filter((message) => message.role === "assistant")
      .every((message) => message.text.trim() || message.parts.length > 0),
  ).toBe(true)
  const replies = await page.locator(".message-assistant").allTextContents()
  expect(replies.every((text) => text.trim().length > 0)).toBe(true)
  expect(replies.filter((text) => text.includes("Verificação retomada e concluída."))).toHaveLength(1)
})
