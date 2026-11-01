import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import type { Bot, BotGroup, Run, Thread } from "@touri/contracts"
import { showWorkMode } from "./home-navigation"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
let releaseDirectory: string | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
  if (releaseDirectory) await rm(releaseDirectory, { recursive: true, force: true })
  releaseDirectory = null
})

const viewportWidths = [1440, 390]
viewportWidths.forEach((width) => {
  test(`edits a real Work channel during an active run at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000)
    page.setDefaultTimeout(15_000)
    const current = await createWorkGoldenServer()
    server = current
    const directory = await mkdtemp(join(tmpdir(), "touri-member-release-"))
    releaseDirectory = directory
    const release = join(directory, "finish")
    await current.setScenario({ deltas: ["Conferindo o plano.", " Plano pronto."], pauseAfterFirstDelta: release })
    const bots = await Promise.all(
      ["Lia", "Nico", "Bia"].map(async (name) => {
        const result = (await current.api("/bots", "POST", {
          name,
          provider: "codex",
          access: "read-only",
          approvals: "on-request",
        })) as { bot: Bot }

        return result.bot
      }),
    )
    const [lia, nico, bia] = bots
    if (!lia || !nico || !bia) throw new Error("Missing synthetic members")
    const { group, thread } = (await current.api("/groups", "POST", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: [lia.id, nico.id],
      coordinatorBotId: null,
    })) as { group: BotGroup; thread: Thread }
    const getRuns = async () => ((await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }).runs
    const getGroup = async () =>
      ((await current.api("/groups")) as { groups: BotGroup[] }).groups.find((candidate) => candidate.id === group.id)
    await current.install(page)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await openWorkWorkspace(page, current.serverUrl)
    await page
      .getByRole("region", { name: "Canais", exact: true })
      .getByRole("button", { name: /^Equipe QA/ })
      .click()
    const composer = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Equipe/ })
    await composer.fill("@Lia confira o plano.")
    await composer.press("Enter")
    await expect
      .poll(
        async () =>
          (await getRuns()).some((run) => run.groupTurnId && run.botId === lia.id && run.status === "running"),
        { timeout: 60_000 },
      )
      .toBe(true)
    await page.getByRole("button", { name: /^Membros do canal:/ }).click()
    const panel = page.getByRole("complementary", { name: /Painel do canal Equipe/ })
    const openEditDialog = async () => {
      await panel.getByRole("button", { name: "Editar canal", exact: true }).click()

      return page.getByRole("dialog", { name: "Editar canal", exact: true })
    }
    const dialog = await openEditDialog()
    await dialog.getByRole("textbox", { name: "Nome do canal", exact: true }).fill("Equipe ampliada QA")
    await dialog.getByRole("checkbox", { name: "Bia", exact: true }).check()

    await dialog.getByRole("button", { name: "Salvar canal", exact: true }).click()

    await expect(dialog).toHaveCount(0)
    expect(await getGroup()).toMatchObject({ name: "Equipe ampliada QA", memberIds: [lia.id, nico.id, bia.id] })
    const updated = await getGroup()
    if (!updated) throw new Error("Missing updated channel")
    await current.api(`/groups/${group.id}`, "PATCH", { ...updated, color: "#2563eb" })
    expect(await getGroup()).toMatchObject({ color: "#2563eb" })
    await expect(panel.getByRole("list", { name: "Membros do canal" }).getByText("Bia", { exact: true })).toBeVisible()
    expect((await getRuns()).filter((run) => run.groupTurnId).map((run) => run.botId)).toEqual([lia.id])
    const evidence = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `members-added-active-${width}.png`), animations: "disabled" })
    const idleRemoval = await openEditDialog()
    await idleRemoval.getByRole("checkbox", { name: "Nico", exact: true }).uncheck()
    await idleRemoval.getByRole("button", { name: "Salvar canal", exact: true }).click()
    await expect(idleRemoval).toHaveCount(0)
    expect(await getGroup()).toMatchObject({ memberIds: [lia.id, bia.id] })
    const busyRemoval = await openEditDialog()
    await busyRemoval.getByRole("checkbox", { name: "Lia", exact: true }).uncheck()
    const rejected = page.waitForResponse(
      (response) => response.url().endsWith(`/api/v1/groups/${group.id}`) && response.request().method() === "PATCH",
    )

    await busyRemoval.getByRole("button", { name: "Salvar canal", exact: true }).click()

    expect((await rejected).status()).toBe(409)
    await expect(busyRemoval.getByRole("alert")).toHaveText("Lia está trabalhando; remova quando terminar.")
    expect(await getGroup()).toMatchObject({ memberIds: [lia.id, bia.id] })
    const accessibility = await new AxeBuilder({ page }).include(".group-modal").analyze()
    expect(accessibility.violations).toEqual([])
    await page.screenshot({ path: join(evidence, `member-busy-reason-${width}.png`), animations: "disabled" })

    await writeFile(release, "finish")

    await expect
      .poll(async () => (await getRuns()).filter((run) => run.groupTurnId).every((run) => run.status === "succeeded"), {
        timeout: 60_000,
      })
      .toBe(true)
    await busyRemoval.getByRole("button", { name: "Salvar canal", exact: true }).click()
    await expect(busyRemoval).toHaveCount(0)
    expect(await getGroup()).toMatchObject({ memberIds: [bia.id] })
    if (await panel.isVisible())
      await panel.getByRole("button", { name: "Fechar painel do canal", exact: true }).click()
    await expect(
      page.getByTestId("virtual-message-list").getByText("Conferindo o plano. Plano pronto.", { exact: true }),
    ).toBeVisible()
    await current.setScenario({ deltas: ["Revisão concluída."] })
    await composer.fill("@Bia revise o plano.")
    await composer.press("Enter")
    await expect(page.getByTestId("virtual-message-list").getByText("Revisão concluída.", { exact: true })).toBeVisible(
      { timeout: 60_000 },
    )
    await expect
      .poll(
        async () =>
          (await getRuns()).some((run) => run.groupTurnId && run.botId === bia.id && run.status === "succeeded"),
        { timeout: 30_000 },
      )
      .toBe(true)
  })
})

const openWorkWorkspace = async (page: Page, url: string) => {
  const composer = page.getByRole("textbox", { name: /Mensagem/ })
  const networkChanged = page
    .waitForEvent("requestfailed", {
      predicate: (request) =>
        request.url().endsWith(".js") && request.failure()?.errorText === "net::ERR_NETWORK_CHANGED",
      timeout: 15_000,
    })
    .then(
      () => true,
      () => false,
    )
  await page.goto(url)
  const isReady = await composer.waitFor({ state: "visible", timeout: 15_000 }).then(
    () => true,
    () => false,
  )

  // A transient network change can drop a startup module. Retry only that navigation before testing edits.
  if (!isReady && (await networkChanged)) await page.reload()
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await showWorkMode(page)
}
