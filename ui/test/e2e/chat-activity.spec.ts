import { mkdir } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const phase = process.env.CHAT_TRANSCRIPT_PHASE ?? "after"
const directory = "../docs/qa/chat-transcript"
test.use({ channel: "chromium", reducedMotion: "reduce" })

for (const theme of ["dark", "light"]) {
  test(`chat activity: 40 actions and a final answer in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.goto(`/test/e2e/chat-activity-harness.html?theme=${theme}`)
    await expect(page.getByRole("heading", { name: "Revisão concluída" })).toBeAttached()
    // The first lazy import can trigger a dependency optimization and reload in the dev fixture.
    if (phase === "after") await expect(page.locator(".mermaid-diagram svg")).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => document.fonts.ready)
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: `${directory}/${phase}-long-${theme}.png` })
    if (phase === "before") return
    const activity = page.locator(".turn-activity")
    await expect(activity).toHaveCount(1)
    await expect(activity.locator(".turn-activity-toggle")).toHaveText("Trabalhou por 3 min · 40 ações")
    await expect(page.getByRole("heading", { name: "Revisão concluída" })).toBeInViewport()
    await expect(page.getByText("Os 40 passos foram concluídos.", { exact: false })).toBeVisible()
    await expect(page.locator(".tool-group")).toHaveCount(0)
    await expect(page.locator(".mermaid-diagram svg")).toBeVisible()
    const toggle = activity.getByRole("button", { name: /40 ações/ })
    await toggle.focus()
    await page.keyboard.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(activity.locator(".turn-activity-step")).toHaveCount(40)
    await expect(activity.locator(".tool-call-card")).toHaveCount(0)
    await activity.getByRole("button", { name: "Detalhes técnicos", exact: true }).click()
    await expect(activity.locator(".tool-call-card")).toHaveCount(40)
    for (const name of ["Arquivos lidos", "Comandos", "Buscas", "Edições", "Raciocínio"])
      await expect(activity.getByRole("heading", { name: new RegExp(name) })).toBeVisible()
    await toggle.focus()
    await page.keyboard.press("Space")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("heading", { name: "Revisão concluída" })).toBeVisible()
  })
}

for (const width of [1100, 390]) {
  test(`chat activity: waiting notices replace each other at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.clock.install()
    await page.goto("/test/e2e/chat-activity-harness.html?scene=waiting&theme=dark")
    await expect(page.locator(".activity-mark")).toHaveCount(1)
    await page.clock.fastForward(10_000)
    await expect(page.locator(".activity-label")).toHaveText("Ainda aguardando a IA responder.")
    await page.clock.fastForward(20_000)
    await expect(
      page.getByText("A resposta está demorando. Você pode continuar esperando ou verificar a conexão."),
    ).toBeVisible()
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: `${directory}/${phase}-waiting-${width}.png` })
    if (phase === "before") return
    await expect(page.getByText("Ainda aguardando a IA responder.")).toHaveCount(0)
    await expect(page.locator(".activity-label[role=status]")).toHaveCount(1)
    await expect(page.locator(".activity-mascot")).toHaveCount(1)
    await expect(page.locator(".turn-activity-toggle")).toHaveCount(1)
    await expect(page.locator(".chat-reasoning > .chat-disclosure-toggle")).toHaveCount(0)
    expect(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.getByRole("button", { name: "Verificar conexão" }).click()
    await expect(page.getByText("A conexão com o touri está disponível. A IA pode continuar demorando.")).toBeVisible()
    await page.evaluate(
      "window.chatActivity.parts([{type:'text',text:'Resposta pronta.'}]); window.chatActivity.finish()",
    )
    await expect(page.getByText("Resposta pronta.")).toBeVisible()
    await expect(page.locator(".activity-mark")).toHaveCount(0)
  })
}
