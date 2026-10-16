import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { showBotPanel } from "./home-navigation"

const evidence = resolve(import.meta.dirname, "../../../docs/qa/groups")
mkdirSync(evidence, { recursive: true })
for (const theme of ["light", "dark"] as const)
  test(`Grupos workflow and screenshots ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 982 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
    await page.goto("/test/e2e/groups-harness.html")
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
    await showBotPanel(page)
    await page.getByRole("button", { name: "Criar grupo", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Criar grupo" })
    await dialog.getByLabel("Nome do grupo").fill("Produto")
    await dialog.getByRole("checkbox", { name: "mark", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "onb", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "Panko", exact: true }).check()
    await dialog.getByLabel("Coordenador", { exact: true }).selectOption("bot-mark")
    await page.screenshot({ path: `${evidence}/create-${theme}.png` })
    const violations = (
      await new AxeBuilder({ page }).include(".group-modal").withTags(["wcag2a", "wcag2aa"]).analyze()
    ).violations
    expect(violations).toEqual([])
    await dialog.getByRole("button", { name: "Criar grupo", exact: true }).click()
    const composer = page.getByRole("textbox", { name: "Mensagem para Produto" })
    await expect(composer).toBeVisible()
    await expect(page.getByText("mark · coordenador, onb, Panko", { exact: true })).toBeVisible()
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
    await expect(
      page
        .getByRole("complementary", { name: "Painel de mark" })
        .getByRole("button", { name: "Produto · coordenador" }),
    ).toBeVisible()
    await page.screenshot({ path: `${evidence}/thread-${theme}.png` })
    await page.getByRole("button", { name: "Editar grupo", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Editar grupo" })
    await edit.getByLabel("Nome do grupo").fill("Produto e Operação")
    await edit.getByLabel("Coordenador", { exact: true }).selectOption("")
    await page.screenshot({ path: `${evidence}/edit-${theme}.png` })
    await edit.getByRole("button", { name: "Salvar grupo" }).click()
    await expect(page.getByRole("textbox", { name: "Mensagem para Produto e Operação" })).toBeVisible()
    await page.getByRole("button", { name: "+ Nova conversa", exact: true }).click()
    await expect(
      page.getByRole("region", { name: "Grupos" }).getByRole("button", { name: "Nova conversa", exact: true }),
    ).toBeVisible()
  })
