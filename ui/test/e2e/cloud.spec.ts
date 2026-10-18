import { spawn } from "node:child_process"
import { once } from "node:events"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import { test as base, expect } from "@playwright/test"

const test = base.extend<{ cloudQaUrl: string }>({
  cloudQaUrl: async ({ baseURL }, use) => {
    if (!baseURL) throw new Error("Missing UI origin for the cloud fixture")

    const server = spawn("bun", [resolve(import.meta.dirname, "../../../test/fakes/cloud-qa.ts")], {
      cwd: resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        TOURI_UI_TOKEN: "dev-ui-token",
        TOURI_CLOUD_QA_PORT: "0",
        TOURI_CLOUD_QA_UI_ORIGIN: new URL(baseURL).origin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const output = createInterface({ input: server.stdout })
    try {
      const url = await new Promise<string>((ready, reject) => {
        output.on("line", (line) => {
          const origin = /^Cloud QA ready: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1]
          if (origin) ready(origin)
        })
        server.once("error", reject)
        server.once("exit", (code) => reject(new Error(`Cloud fixture exited before readiness (${code})`)))
      })

      await use(url)
    } finally {
      output.close()
      if (server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit")
        server.kill("SIGTERM")
        await exited
      }
    }
  },
})

test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })

for (const theme of ["light", "dark"] as const) {
  test(`cloud protocol pairing, plan, wizard and lifecycle · ${theme}`, async ({ page, request, cloudQaUrl }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript((value) => localStorage.setItem("touri.appearance.v1", value), theme)
    await page.goto(`/test/e2e/cloud-harness.html?connected=false&fixture=${encodeURIComponent(cloudQaUrl)}`)
    await page.getByRole("tab", { name: "Privacidade" }).click()
    await page.getByText("Dados, permissões e conexões").click()
    await page.getByRole("button", { name: "Entrar em uma conta", exact: true }).click()
    const code = page.locator(".cloud-pairing > strong")
    await expect(code).toBeVisible()
    await page.screenshot({ path: `../docs/qa/cloud/pairing-${theme}.png` })
    const approval = await request.post(`${cloudQaUrl}/approve`, { data: { userCode: await code.textContent() } })
    expect(approval.ok()).toBe(true)
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
    await page.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }).click()
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
