import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { type Browser, expect, type Page, test } from "@playwright/test"
import { type FixtureSite, startFixtureSite } from "./fixture-server"
import { decideOption } from "./mock-jev"
import { FINAL_ANSWER, FIXTURE_LOGIN_VALUE, type FlowSnapshot, runScriptedBot } from "./scripted-bot"

// Strict assertions for the owner-approved flow (live subtitle, quiet narration, thumbnail/log split, "Ver as etapas").
// They describe the finished card, so they run with TOURI_CU_CONCEPT=1 once the card branch is merged.
const conceptOnly = process.env.TOURI_CU_CONCEPT !== "1"
const pace = Number(process.env.CU_PACE ?? 250)
const evidenceDir = process.env.CU_EVIDENCE_DIR

type FlowWindow = Window & {
  cuFlow?: { publish: (s: FlowSnapshot) => void; isHeld: () => boolean; sent: () => string[] }
}

const variants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
]

test.use({ video: "on" })

let site: FixtureSite

test.beforeAll(async () => {
  site = await startFixtureSite()
})

test.afterAll(async () => {
  await site.close()
})

const getSitePage = async (browser: Browser) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "pt-BR" })

  return { page: await context.newPage(), close: () => context.close() }
}

const shoot = async (ui: Page, variant: string, name: string) => {
  if (!evidenceDir) return
  await mkdir(join(evidenceDir, variant), { recursive: true })
  await ui.screenshot({ path: join(evidenceDir, variant, `${name}.png`) })
}

test.describe("fixture travel site", () => {
  test("search, autocomplete, date picker, results and the login wall work without the bot", async ({ browser }) => {
    const { page, close } = await getSitePage(browser)
    await page.goto(site.url)

    await page.getByRole("combobox", { name: "Destino" }).pressSequentially("Chicago")
    await expect(page.getByRole("option")).toHaveCount(3)
    await page.getByRole("option", { name: "Chicago, Illinois, EUA" }).click()
    await page.getByRole("button", { name: "10 de novembro" }).click()
    await page.getByRole("button", { name: "14 de novembro" }).click()
    await page.getByRole("button", { name: "Buscar" }).click()
    await expect(page.getByRole("heading", { name: "4 estadias em Chicago" })).toBeVisible()
    await expect(page.getByRole("article")).toHaveCount(4)
    await page.getByRole("button", { name: "Reservar" }).first().click()
    await expect(page.getByRole("heading", { name: "Entre para ver o preço final" })).toBeVisible()
    await page.getByLabel("E-mail").fill("voce@exemplo.com")
    await page.getByLabel("Senha").fill(FIXTURE_LOGIN_VALUE)
    await page.getByRole("button", { name: "Continuar" }).click()
    await expect(page.getByText("Total R$ 4.430")).toBeVisible()
    await close()
  })

  test("the mocked JEV picks the exact city and reports its confidence", () => {
    const options = ["Chicago Heights, Illinois", "Chicago, Illinois, EUA", "Chicago Ridge, Illinois"].map((name) => ({
      ref: name,
      name,
    }))

    expect(decideOption("Chicago", options)).toEqual({
      choice: "Chicago, Illinois, EUA",
      confidence: 0.97,
      options: options.map((option) => option.name),
    })
    expect(decideOption("Paris", options)).toBeUndefined()
  })
})

for (const variant of variants) {
  test.describe(`computer use flow: ${variant.name}`, () => {
    test.use({
      viewport: { width: variant.width, height: variant.height },
      colorScheme: variant.colorScheme,
    })
    test.setTimeout(120_000)

    const play = async (ui: Page, browser: Browser, afterStep: (index: number) => Promise<void>) => {
      const { page, close } = await getSitePage(browser)
      const run = runScriptedBot({
        site: page,
        siteUrl: site.url,
        pace,
        startedAt: Date.now() - 2_000,
        publish: (snapshot) => ui.evaluate((value) => (window as FlowWindow).cuFlow?.publish(value), snapshot),
        waitForHandback: async () => {
          await ui.waitForFunction(() => (window as FlowWindow).cuFlow?.isHeld() === true, undefined, {
            timeout: 60_000,
          })
          await ui.waitForFunction(() => (window as FlowWindow).cuFlow?.isHeld() === false, undefined, {
            timeout: 60_000,
          })
        },
        afterStep,
      })

      return { page, run, close }
    }

    test("ten actions, a login wall, a take-over and a formatted answer", async ({ page: ui, browser }, testInfo) => {
      await ui.goto(`/test/e2e/computer-use/flow-harness.html?theme=${variant.theme}`)
      await expect(ui.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
      const chip = ui.locator(".composer-browser-status")
      const card = ui.locator(".browser-activity-card")
      const snapshots: string[] = []
      const bot = await play(ui, browser, async (index) => {
        await expect(chip).toContainText("Léo está trabalhando · No navegador")
        await expect(card).toBeVisible()
        snapshots.push(`step-${index + 1}`)
        await shoot(ui, variant.name, `step-${String(index + 1).padStart(2, "0")}`)
      })

      await expect(ui.getByText(/O site pediu login/u)).toBeVisible({ timeout: 60_000 })
      await shoot(ui, variant.name, "login-wall")
      await ui.locator(".composer-browser-status").getByRole("button", { name: "Assumir" }).click()
      await expect(ui.locator(".browser-activity-card").getByRole("button", { name: /Devolver para/ })).toBeVisible()
      await bot.page.getByLabel("E-mail").fill("voce@exemplo.com")
      await bot.page.getByLabel("Senha").fill(FIXTURE_LOGIN_VALUE)
      await expect(ui.locator("body")).not.toContainText(FIXTURE_LOGIN_VALUE)
      expect(await ui.evaluate(() => (window as FlowWindow).cuFlow?.sent())).toEqual([])
      await bot.page.getByRole("button", { name: "Continuar" }).click()
      await shoot(ui, variant.name, "taken-over")
      await ui
        .locator(".browser-activity-card")
        .getByRole("button", { name: /Devolver para/ })
        .click()
      await bot.run

      expect(snapshots).toHaveLength(12)
      await expect(chip).toHaveCount(0)
      await expect(ui.getByRole("button", { name: /Usou o navegador/ })).toBeVisible()
      await expect(ui.getByRole("listitem")).toHaveCount(4)
      await expect(ui.getByText("Loft no West Loop")).toBeVisible()
      await expect(ui.locator("body")).not.toContainText(FIXTURE_LOGIN_VALUE)
      expect(FINAL_ANSWER).toContain("1. **Loft no West Loop**")
      await shoot(ui, variant.name, "final")
      const horizontalOverflow = await ui.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(horizontalOverflow).toBeLessThanOrEqual(0)

      const video = ui.video()
      await ui.close()
      await bot.close()
      if (video)
        await video.saveAs(
          evidenceDir ? join(evidenceDir, `${variant.name}.webm`) : testInfo.outputPath(`${variant.name}.webm`),
        )
    })

    if (!conceptOnly)
      test("the live card follows the concept step by step", async ({ page: ui, browser }) => {
        await ui.goto(`/test/e2e/computer-use/flow-harness.html?theme=${variant.theme}`)
        const card = ui.getByRole("region", { name: "Navegador do Léo" })
        const stepChecks: Record<number, () => Promise<void>> = {
          1: async () => {
            await expect(card).toContainText("Léo · lendo a página")
            await expect(card.getByText("Abriu uma página")).toBeVisible()
            await expect(
              ui.getByText("Estou na página inicial. Vou digitar Chicago e escolher a sugestão certa."),
            ).toBeVisible()
            await expect(ui.getByRole("progressbar")).toBeVisible()
          },
          2: async () => expect(card).toContainText("preencheu um campo"),
          3: async () => expect(card.getByText("Clicou em “Chicago, Illinois, EUA”")).toBeVisible(),
          6: async () => expect(card).toContainText("estadias.exemplo/s/chicago"),
          8: async () =>
            expect(ui.getByRole("button", { name: /Usou o navegador · \d+ ações?/ }).first()).toBeVisible(),
          9: async () => {
            await expect(card.getByText("Tirou um print")).toBeVisible()
            await expect(card.getByRole("button", { name: "Assumir" })).toBeVisible()
          },
        }
        const bot = await play(ui, browser, async (index) => {
          await stepChecks[index]?.()
          const preview = card.getByRole("img", { name: "Página atual do navegador" })
          const [cardBox, previewBox] = [await card.boundingBox(), await preview.boundingBox()]
          if (!cardBox || !previewBox) return
          if (variant.width > 600) expect(previewBox.width / cardBox.width).toBeGreaterThan(0.5)
          if (variant.width <= 600) expect(previewBox.width / cardBox.width).toBeGreaterThan(0.8)
        })

        await expect(ui.getByText(/O site pediu login/u)).toBeVisible({ timeout: 60_000 })
        await ui.locator(".composer-browser-status").getByRole("button", { name: "Assumir" }).click()
        await ui
          .locator(".browser-activity-card")
          .getByRole("button", { name: /Devolver para/ })
          .click()
        await bot.run

        await expect(ui.getByRole("button", { name: /Usou o navegador · \d+ ações/ })).toBeVisible()
        await ui.getByRole("button", { name: "Ver as etapas" }).click()
        await expect(ui.getByText("Abriu uma página")).toBeVisible()
        await bot.close()
      })
  })
}
