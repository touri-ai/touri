import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test("the board retains a removed member beside the surviving result on desktop and phone", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/group-member-removal-harness.html")
  const board = page.getByRole("region", { name: "Resultados do turno", exact: true })

  await expect(board.getByText("Plano revisado. A equipe pode continuar.")).toBeVisible()
  await expect(board.getByText("Revisor", { exact: true })).toBeVisible()
  await expect(board.getByText("O membro foi removido do grupo.")).toBeVisible()

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: testInfo.outputPath("group-partial-success-removed-desktop.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(board.getByText("O membro foi removido do grupo.")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("group-partial-success-removed-phone.png") })
})

test("group actions send a parallel request and show a confirmed board on desktop and phone", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/test/e2e/groups-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const qa = window as typeof window & {
      groupsQa: { api: { request: (route: string, input: unknown) => Promise<unknown> } }
    }
    await qa.groupsQa.api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
  })
  await page.getByRole("button", { name: "Equipe", exact: true }).click()
  const input = page.getByRole("textbox", { name: "Mensagem para Equipe", exact: true })
  await input.fill("Revisem o plano")

  await page.getByRole("button", { name: "Perguntar a todos", exact: true }).click()

  await expect(input).toHaveValue("")
  await expect(
    page.getByText(
      "Coloquei sua solicitação na fila local. Vou manter o contexto da conversa, e o próximo passo está pronto.",
    ),
  ).toBeVisible()
  const turn = await page.evaluate(() => {
    const qa = window as typeof window & {
      groupsQa: {
        api: { getState: () => { threads: { id: string; groupId?: string | null }[] }; emit: (event: unknown) => void }
      }
    }
    const thread = qa.groupsQa.api.getState().threads.find((candidate) => candidate.groupId)
    if (!thread) throw new Error("Missing fixture group")
    const root = {
      id: "team-turn",
      threadId: thread.id,
      botId: "bot-mark",
      provider: "codex",
      trigger: "user",
      status: "running",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }
    qa.groupsQa.api.emit({ type: "run.updated", run: root })
    qa.groupsQa.api.emit({ type: "run.updated", run: { ...root, id: "waiting-run", groupTurnId: root.id } })
    qa.groupsQa.api.emit({
      type: "message.created",
      message: {
        id: "waiting",
        threadId: thread.id,
        parentId: null,
        role: "assistant",
        kind: "approval",
        status: "streaming",
        runId: "waiting-run",
        text: "",
        parts: [
          {
            type: "approval",
            approvalId: "team-consent",
            request: "permission",
            decision: "pending",
            detail: "Revise o plano",
            scope: { source: "mcp", tool: "ask_all", server: "touri" },
          },
        ],
        sender: { id: "bot-mark", name: "mark" },
        source: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    qa.groupsQa.api.emit({
      type: "message.created",
      message: {
        id: "confirmed",
        threadId: thread.id,
        parentId: null,
        role: "assistant",
        kind: "text",
        status: "complete",
        runId: "member-run",
        text: "Plano aprovado na revisão",
        parts: [
          { type: "text", text: "Plano aprovado na revisão" },
          { type: "reasoning", text: "Raciocínio privado" },
        ],
        sender: { id: "bot-onb", name: "onb" },
        source: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    qa.groupsQa.api.emit({
      type: "run.updated",
      run: {
        ...root,
        id: "member-run",
        botId: "bot-onb",
        groupTurnId: root.id,
        status: "succeeded",
        replyMessageId: "confirmed",
        finishedAt: Date.now(),
      },
    })
    return root
  })
  const panel = page.getByRole("complementary", { name: "Painel do grupo Equipe", exact: true })
  if (!(await panel.isVisible())) await page.getByRole("button", { name: "Painel do grupo", exact: true }).click()
  const board = panel.getByRole("region", { name: "Resultados do turno", exact: true })
  await expect(board.getByText("Plano aprovado na revisão")).toBeVisible()
  await expect(board.getByText("Raciocínio privado")).toHaveCount(0)
  await expect(panel.getByText("Trabalhando", { exact: true })).toHaveCount(0)
  await expect(panel.getByText("Aguardando você", { exact: true })).toBeVisible()
  await page.evaluate((root) => {
    const qa = window as typeof window & { groupsQa: { api: { emit: (event: unknown) => void } } }
    qa.groupsQa.api.emit({
      type: "run.updated",
      run: {
        ...root,
        id: "waiting-run",
        groupTurnId: root.id,
        status: "failed",
        errorClass: "unknown",
        finishedAt: Date.now(),
      },
    })
  }, turn)
  await expect(panel.getByText("Falhou", { exact: true })).toHaveCount(1)
  await expect(panel.getByText("Disponível", { exact: true })).toHaveCount(1)
  await expect(board.getByText("Plano aprovado na revisão")).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: testInfo.outputPath("group-partial-success-desktop.png") })
  const violations = (await new AxeBuilder({ page }).include(".group-panel").withTags(["wcag2a", "wcag2aa"]).analyze())
    .violations
  expect(violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(board.getByText("Plano aprovado na revisão")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("group-partial-success-phone.png") })
})
