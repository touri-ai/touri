import { resolve } from "node:path"
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"

test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" })

for (const theme of ["dark", "light"] as const) {
  test(`project name keeps a contrasting keyboard focus border in ${theme}`, async ({ page }, info) => {
    await openMock(page, theme)
    await page.keyboard.press("Control+k")
    await page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" }).fill("Conectar projeto")
    await page.getByRole("option", { name: /Conectar projeto/ }).click()
    const dialog = page.getByRole("dialog", { name: "Conectar projeto", exact: true })
    const field = dialog.getByLabel("Nome do projeto", { exact: true })
    await dialog.getByRole("button", { name: "Escolher pasta", exact: true }).focus()
    const unfocused = await getFieldStyle(field)

    await page.keyboard.press("Tab")

    await expect(field).toBeFocused()
    await captureFocus(page, info, `project-${theme}`)
    await expectFocusBorder(field, unfocused)
    await expectForcedColorsFocus(page, field)
  })

  test(`group name keeps a contrasting keyboard focus border in ${theme}`, async ({ page }, info) => {
    await openMock(page, theme)
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.getByRole("button", { name: "Novo canal", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Criar canal", exact: true })
    const field = dialog.getByLabel("Nome do canal", { exact: true })
    await dialog.getByRole("button", { name: "Fechar canal", exact: true }).focus()
    const unfocused = await getFieldStyle(field)

    await page.keyboard.press("Tab")

    await expect(field).toBeFocused()
    await captureFocus(page, info, `group-${theme}`)
    await expectFocusBorder(field, unfocused)
    await expectForcedColorsFocus(page, field)
  })

  test(`borderless composer and search keep focus on their containers in ${theme}`, async ({ page }) => {
    await openMock(page, theme)
    await page.getByRole("tab", { name: /^Work,/ }).click()
    const composer = page.getByRole("textbox", { name: "Mensagem para mark", exact: true })
    const container = page.locator(".composer-island")
    await page.getByRole("button", { name: "Novo canal", exact: true }).focus()
    const unfocusedShadow = await container.evaluate((element) => getComputedStyle(element).boxShadow)

    await composer.press("Shift+Tab")
    await page.keyboard.press("Tab")

    await expect(composer).toBeFocused()
    await expectBorderlessFocus(composer)
    await expect(container).not.toHaveCSS("box-shadow", unfocusedShadow)

    await page.keyboard.press("Control+k")
    const search = page.getByRole("combobox", { name: "Buscar bots, conversas e configurações" })

    await expect(search).toBeFocused()
    await expectBorderlessFocus(search)
    await expect(page.locator(".command-palette-input")).not.toHaveCSS("box-shadow", "none")
  })
}

const openMock = async (page: Page, theme: string) => {
  await page.addInitScript((theme) => localStorage.setItem("touri.appearance.v1", theme), theme)
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
}

const captureFocus = async (page: Page, info: TestInfo, name: string) => {
  const directory = process.env.TOURI_FOCUS_EVIDENCE_DIR
  const path = directory ? resolve(directory, `${name}.png`) : info.outputPath(`${name}.png`)

  await page.screenshot({ path, animations: "disabled" })
  await info.attach(name, { path, contentType: "image/png" })
}

const expectFocusBorder = async (field: Locator, unfocused: Awaited<ReturnType<typeof getFieldStyle>>) => {
  const focused = await getFieldStyle(field)
  const contrast = {
    field: getContrast(focused.borderColor, focused.backgroundColor),
    surrounding: getContrast(focused.borderColor, focused.surroundingColor),
    unfocused: getContrast(focused.borderColor, unfocused.borderColor),
  }

  expect(focused.focusVisible).toBe(true)
  expect(focused.borderStyle).toBe("solid")
  expect(Number.parseFloat(focused.borderWidth)).toBeGreaterThanOrEqual(1)
  expect(focused.borderColor).not.toBe(unfocused.borderColor)
  expect(contrast.field).toBeGreaterThanOrEqual(3)
  expect(contrast.surrounding).toBeGreaterThanOrEqual(3)
  expect(contrast.unfocused).toBeGreaterThanOrEqual(3)
  console.log("Field focus contrast", contrast)
}

const getFieldStyle = (field: Locator) =>
  field.evaluate((element) => {
    const style = getComputedStyle(element)
    const dialog = element.closest(".modal-card")
    if (!dialog) throw new Error("Missing field dialog")

    return {
      focusVisible: element.matches(":focus-visible"),
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      backgroundColor: style.backgroundColor,
      surroundingColor: getComputedStyle(dialog).backgroundColor,
    }
  })

const getContrast = (foreground: string, background: string) => {
  const first = getLuminance(foreground)
  const second = getLuminance(background)

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const getLuminance = (color: string) => {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number)
  if (channels?.length !== 3) throw new Error(`Unsupported computed color: ${color}`)

  return channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((luminance, channel, index) => luminance + channel * ([0.2126, 0.7152, 0.0722][index] ?? 0), 0)
}

const expectForcedColorsFocus = async (page: Page, field: Locator) => {
  await page.emulateMedia({ forcedColors: "active" })

  await expect(field).toHaveCSS("outline-style", "solid")
  await expect(field).toHaveCSS("outline-width", "2px")
  await expect(field).toHaveCSS("outline-offset", "3px")
}

const expectBorderlessFocus = async (field: Locator) => {
  await expect(field).toHaveCSS("border-top-width", "0px")
  await expect(field).toHaveCSS("outline-style", "none")
  await expect(field).toHaveCSS("box-shadow", "none")
  expect(await field.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
}
