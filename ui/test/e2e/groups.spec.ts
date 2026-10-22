import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

const evidence = resolve(import.meta.dirname, "../../../docs/qa/groups")
mkdirSync(evidence, { recursive: true })
test.setTimeout(60_000)
for (const theme of ["light", "dark"] as const)
  test(`Grupos workflow and screenshots ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 982 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await showBotPanel(page)
    await page.getByRole("button", { name: "Novo canal", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Criar canal" })
    await dialog.getByLabel("Nome do canal").fill("Produto")
    await dialog.getByRole("checkbox", { name: "mark", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "onb", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "Panko", exact: true }).check()
    await dialog.getByLabel("Coordenador do canal", { exact: true }).selectOption("bot-mark")
    await page.screenshot({ path: `${evidence}/create-${theme}.png` })
    const violations = (
      await new AxeBuilder({ page }).include(".group-modal").withTags(["wcag2a", "wcag2aa"]).analyze()
    ).violations
    expect(violations).toEqual([])
    await dialog.getByRole("button", { name: "Criar canal", exact: true }).click()
    const composer = page.getByRole("textbox", { name: "Mensagem para Produto" })
    await expect(composer).toBeVisible()
    await expect(page.getByRole("button", { name: "Membros do canal: 3 bots", exact: true })).toBeVisible()
    await composer.fill("@on")
    await expect(page.getByRole("option", { name: "@onb" })).toBeVisible()
    await page.screenshot({ path: `${evidence}/mentions-${theme}.png` })
    await composer.press("Enter")
    await expect(composer).toHaveValue("@onb ")
    await composer.fill("")
    await page.evaluate(() => {
      const api = (
        window as unknown as {
          groupsQa: {
            api: { getState: () => { threads: { id: string; groupId?: string }[] }; emit: (event: unknown) => void }
          }
        }
      ).groupsQa.api
      const thread = api.getState().threads.find((t) => t.groupId)
      if (!thread) throw new Error("Group missing")
      for (const [index, name, text] of [
        [0, "mark", "Vou coordenar o lançamento. onb, valide a operação; Panko, revise a experiência."],
        [1, "onb", "Operação revisada. As aprovações continuam sendo solicitadas no meu computador."],
        [2, "Panko", "Revisei o fluxo. Podemos seguir com o lançamento."],
      ] as const) {
        const message = {
          id: `group-answer-${index}`,
          threadId: thread.id,
          parentId: index ? `group-answer-${index - 1}` : null,
          role: "assistant",
          kind: "text",
          status: "complete",
          runId: null,
          text,
          parts: [{ type: "text", text }],
          sender: { id: `bot-${name.toLowerCase()}`, name },
          source: "local",
          createdAt: Date.now() + index,
          updatedAt: Date.now() + index,
        }
        api.emit({ type: "message.created", message })
      }
    })
    await expect(
      page.locator('[data-message-id="group-answer-2"]').getByText("Revisei o fluxo. Podemos seguir com o lançamento."),
    ).toBeVisible()
    await expect(page.locator('[data-message-id="group-answer-1"] .message-role')).toHaveText("onb")
    const groupPanel = page.getByRole("complementary", { name: "Painel do canal Produto", exact: true })
    await expect(groupPanel).toBeVisible()
    const members = groupPanel.getByRole("list", { name: "Membros do canal" })
    for (const name of ["mark", "onb", "Panko"]) await expect(members.getByText(name, { exact: true })).toBeVisible()
    await expect(members.getByText("Bot", { exact: true })).toHaveCount(3)
    await expect(groupPanel.getByRole("button", { name: "Editar canal", exact: true })).toBeVisible()
    await expect(groupPanel.getByRole("button", { name: "Preview do projeto", exact: true })).toHaveCount(0)
    await expect(page.getByRole("complementary", { name: "Painel de mark" })).toHaveCount(0)
    await page.screenshot({ path: `${evidence}/thread-${theme}.png` })

    await page.locator('[data-work-bot-entry="bot-mark"] .bot-row-main').click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
    const botPanel = page.getByRole("complementary", { name: "Painel de mark", exact: true })
    await expect(botPanel).toBeVisible()
    await expect(botPanel.getByRole("button", { name: "Preview do projeto", exact: true })).toBeVisible()
    await botPanel.getByRole("button", { name: "Produto · coordenador", exact: true }).click()
    await expect(composer).toBeVisible()
    await expect(groupPanel).toBeVisible()
    await groupPanel.getByRole("button", { name: "Editar canal", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Editar canal" })
    await edit.getByLabel("Nome do canal").fill("Produto e Operação")
    await edit.getByLabel("Coordenador do canal", { exact: true }).selectOption("")
    await page.screenshot({ path: `${evidence}/edit-${theme}.png` })
    await edit.getByRole("button", { name: "Salvar canal" }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Produto e Operação" })).toBeVisible()
    const channels = page.getByRole("region", { name: "Canais" })
    const channelActions = channels.getByRole("button", { name: "Ações do canal Produto e Operação" })
    await channels
      .locator(".sidebar-row")
      .filter({ has: page.getByRole("button", { name: "Ações do canal Produto e Operação" }) })
      .hover()
    await channelActions.click()
    await page.getByRole("menuitem", { name: "Nova conversa", exact: true }).click()
    await expect(
      page.getByRole("region", { name: "Canais" }).getByRole("button", { name: "Nova conversa", exact: true }),
    ).toBeVisible()
  })
