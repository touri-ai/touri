import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { expect } from "@playwright/test"
import { test } from "./production-fixture"

test.setTimeout(90_000)
// Trace DOM snapshots add work to the same event loop whose latency this suite measures.
test.use({ trace: { mode: "retain-on-failure", screenshots: false, snapshots: false, sources: false } })
const phase = process.env.FEEDBACK_PHASE ?? "after"
const directory = fileURLToPath(new URL("../../../docs/qa/response-feedback/", import.meta.url))
const url = "/test/e2e/response-feedback-harness.html"

for (const width of [1440, 390]) {
  test(`captures response activity at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.clock.install()
    await page.goto(url)
    await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Organize minhas notas em uma lista.")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await page.clock.fastForward(300)
    await expect(page.locator(".activity-mark")).toBeVisible()
    await page.evaluate(
      "window.feedback.provider(); window.feedback.parts([{type:'reasoning',text:'Checking the available context before replying',estimatedTokens:120}])",
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      path: `${directory}/${phase}-${width}.png`,
      mask: [page.locator(".composer-model")],
      maskColor: "#222",
    })
    if (phase === "before") return
    await expect(page.locator(".activity-label")).toHaveText("Preparando a resposta…")
    await expect(page.locator(".turn-activity-toggle")).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("button", { name: "Raciocínio", exact: true })).toHaveCount(0)
    await page.clock.fastForward(10_250)
    await expect(page.locator(".activity-label")).toHaveText("Ainda aguardando a IA responder.")
    await page.clock.fastForward(20_000)
    await expect(page.locator(".activity-label")).toHaveText(
      "A resposta está demorando. Você pode continuar esperando ou verificar a conexão.",
    )
    await expect(page.locator(".activity-label")).toHaveCount(1)
    await expect(page.locator(".message-avatar .tb-avatar")).toHaveCount(1)
    await expect(page.locator(".activity-mascot")).toHaveCount(0)
    await expect(page.getByText("Ainda aguardando a IA responder.", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Verificar conexão", exact: true })).toBeVisible()
    await page.screenshot({
      path: `${directory}/long-wait-${width}.png`,
      mask: [page.locator(".composer-model")],
      maskColor: "#222",
    })
    const warning = page.locator(".activity-mark")
    expect(await warning.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.getByRole("button", { name: "Verificar conexão", exact: true }).click()
    await expect(page.getByText("A conexão com o touri está disponível. A IA pode continuar demorando.")).toBeVisible()
    expect(await page.evaluate("window.feedback.sends()")).toBe(1)
    await page.getByRole("button", { name: "Parar", exact: true }).first().click()
    await expect(page.locator(".activity-mark")).toHaveCount(0)
  })
}

if (phase === "after") {
  test("first provider event at 35 seconds never leaves a frozen or misleading chat", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.clock.install()
    await page.goto(url)
    await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Organize minhas notas.")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await page.clock.fastForward(300)
    await page.evaluate("window.feedback.provider()")
    await expect(page.locator(".activity-label")).toHaveText("Preparando a resposta…")
    await page.clock.fastForward(10_250)
    await expect(page.locator(".activity-label")).toHaveText("Ainda aguardando a IA responder.")
    await page.clock.fastForward(20_000)
    await expect(page.locator(".activity-label")).toHaveText(
      "A resposta está demorando. Você pode continuar esperando ou verificar a conexão.",
    )
    await expect(page.getByText("Ainda aguardando a IA responder.", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Verificar conexão" })).toBeVisible()
    await page.clock.fastForward(4_750)
    expect(await page.evaluate("window.feedback.sends()")).toBe(1)
    await page.evaluate("window.feedback.parts([{type:'reasoning',text:'Checking context',estimatedTokens:500}])")
    await expect(page.locator(".activity-label")).toHaveText("Preparando a resposta…")
    await expect(page.locator(".activity-label")).not.toContainText(/Checking|tokens|%/)
    await expect(page.locator(".activity-delay")).toHaveCount(0)
    await page.evaluate("window.feedback.parts([{type:'text',text:'Notas organizadas.'}]); window.feedback.finish()")
    await expect(
      page.getByTestId("virtual-message-list").getByText("Notas organizadas.", { exact: true }),
    ).toBeVisible()
    await expect(page.locator(".activity-mark")).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test("measures local confirmation and accepted activity in ten first conversations", async ({ page }) => {
    test.setTimeout(240_000)
    const measurements: Array<{
      conversation: number
      confirmationMs: number
      acceptedActivityMs: number
      timing: unknown
    }> = []
    for (let conversation = 1; conversation <= 10; conversation++) {
      await page.goto(`${url}?conversation=${conversation}`)
      await page.getByRole("textbox", { name: "Mensagem para mark" }).fill("Organize minhas notas.")
      await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled()
      // Finish the draft commit and its layout before measuring the next user action.
      await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      )
      const { confirmationMs, acceptedActivityMs } = await page.evaluate(
        () =>
          new Promise<{ confirmationMs: number; acceptedActivityMs: number }>((resolve) => {
            const before = performance.now()
            let confirmationMs: number | undefined
            const observer = new MutationObserver(() => {
              if (document.querySelector(".delivery-state")) confirmationMs ??= performance.now() - before
              if (confirmationMs === undefined || !document.querySelector(".activity-mark")) return
              observer.disconnect()
              resolve({
                confirmationMs,
                acceptedActivityMs: performance.now() - Reflect.get(window, "feedback").acceptedAt(),
              })
            })
            observer.observe(document.body, { childList: true, subtree: true })
            document.querySelector<HTMLButtonElement>(".composer-send")?.click()
          }),
      )
      expect(confirmationMs).toBeLessThanOrEqual(100)
      expect(acceptedActivityMs).toBeLessThanOrEqual(250)
      await page.evaluate("window.feedback.provider()")
      // The scenarios above cover provider delay with a virtual clock; this measures local confirmation.
      await page.evaluate("window.feedback.parts([{type:'reasoning',text:'Checking context'}])")
      await page.evaluate("window.feedback.parts([{type:'text',text:'Notas organizadas.'}]); window.feedback.finish()")
      const timings = (await page.evaluate("window.feedback.timings()")) as Array<{
        sendToAcceptMs: number | null
        acceptToFirstEventMs: number | null
        sendToFirstTextMs: number | null
      }>
      expect(timings).toHaveLength(conversation)
      expect(timings.at(-1)).toMatchObject({
        sendToAcceptMs: expect.any(Number),
        acceptToFirstEventMs: expect.any(Number),
        sendToFirstTextMs: expect.any(Number),
      })
      measurements.push({ conversation, confirmationMs, acceptedActivityMs, timing: timings.at(-1) })
      await mkdir(directory, { recursive: true })
      await writeFile(`${directory}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`)
    }
    await mkdir(directory, { recursive: true })
    await writeFile(`${directory}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`)
  })
}
