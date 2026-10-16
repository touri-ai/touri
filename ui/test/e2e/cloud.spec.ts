import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"] as const) {
  test(`cloud protocol pairing, plan, wizard and lifecycle · ${theme}`, async ({ page, request }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
    await page.goto("/test/e2e/cloud-harness.html?connected=false")
    await page.getByRole("tab", { name: "Privacidade" }).click()
    await page.getByText("Dados, permissões e conexões").click()
    await page.getByRole("button", { name: "Entrar em uma conta", exact: true }).click()
    const code = page.locator(".cloud-pairing > strong")
    await expect(code).toBeVisible()
    await page.screenshot({ path: `../docs/qa/cloud/pairing-${theme}.png` })
    await request.post("http://127.0.0.1:1480/approve", { data: { userCode: await code.textContent() } })
    await expect(page.getByText("Cloud Solo · sandbox")).toBeVisible({ timeout: 12_000 })
    await expect(page.getByText("2 h de 20 h")).toBeVisible()
    await page.screenshot({ path: `../docs/qa/cloud/preferences-${theme}.png` })
    await page.getByText("2 h de 20 h").scrollIntoViewIfNeeded()
    await page.screenshot({ path: `../docs/qa/cloud/preferences-usage-${theme}.png` })
    await page.getByRole("button", { name: "Fechar diálogo" }).click()
    await expect(page.getByRole("status")).toHaveText("Hibernado")
    await page.screenshot({ path: `../docs/qa/cloud/computer-hibernated-${theme}.png` })
    await page.getByRole("button", { name: "Acordar", exact: true }).click()
    await expect(page.getByRole("status")).toHaveText("Rodando")
    await page.screenshot({ path: `../docs/qa/cloud/computer-running-${theme}.png` })
    await page.getByRole("button", { name: "Hibernar", exact: true }).click()
    await expect(page.getByRole("status")).toHaveText("Hibernado")
    await page.getByRole("button", { name: "Novo bot" }).click()
    await page.getByLabel("Nome", { exact: true }).fill("Pedro")
    await page.getByRole("button", { name: "Avançado", exact: true }).click()
    await expect(page.getByRole("option", { name: "Na nuvem" })).toBeAttached()
    await page.getByLabel("Máquina", { exact: true }).selectOption("cloud")
    await page.getByLabel("Chave API do OpenAI").fill("qa-api-key")
    await page.screenshot({ path: `../docs/qa/cloud/wizard-${theme}.png` })
    expect(errors).toEqual([])
    expect(await page.getByRole("dialog").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      1,
    )
  })
}
