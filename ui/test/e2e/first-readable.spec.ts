import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, Run, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | undefined

test.afterEach(async () => server?.dispose())

test("first readable reply preserves leading whitespace and the draft", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer({ withSyntheticProfile: true })
  server = current
  await current.setScenario({
    events: [
      { type: "delta", delta: " \n" },
      { type: "sleep" },
      { type: "delta", delta: "Plano fictício conferido." },
      { type: "sleep" },
      { type: "complete" },
    ],
  })
  const { bot } = (await current.api("/bots", "POST", {
    name: "Brisa",
    provider: "codex",
    providerProfile: "synthetic",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { threads } = (await current.api(`/bots/${bot.id}/threads`)) as { threads: Thread[] }
  const thread = threads[0]
  if (!thread) throw new Error("Missing synthetic thread")
  await current.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${current.serverUrl}/?bot=${bot.id}&thread=${thread.id}`)
  const input = page.getByRole("textbox", { name: "Mensagem para Brisa" })
  await expect(input).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Sua mensagem fica como rascunho até o login estar pronto.", { exact: true }),
  ).toHaveCount(0)
  await input.fill("Confira o plano fictício.")
  await page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Enviar"]')
    if (!send) throw new Error("Send button missing")
    send.addEventListener(
      "click",
      () => {
        const start = Date.now()
        const observer = new MutationObserver(() => {
          if (!document.querySelector(".message-assistant")?.textContent?.includes("Plano fictício conferido.")) return
          Object.assign(window, { firstReadableObservation: { clickAt: start, domAt: Date.now() } })
          observer.disconnect()
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      },
      { once: true },
    )
  })
  await page.getByRole("button", { name: "Enviar", exact: true }).click()
  await expect(page.locator(".message-assistant").getByText("Plano fictício conferido.", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await input.fill("Rascunho fictício preservado.")
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await expect(input).toHaveValue("Rascunho fictício preservado.")
    const path = process.env.TOURI_READABLE_EVIDENCE_DIR
      ? join(process.env.TOURI_READABLE_EVIDENCE_DIR, `${process.env.TOURI_READABLE_PHASE ?? "after"}-${width}.png`)
      : testInfo.outputPath(`readable-${width}.png`)
    await page.screenshot({
      path,
      animations: "disabled",
      mask: [page.locator(".composer-model"), page.locator(".project-picker")],
    })
    await testInfo.attach(`readable-${width}`, { path, contentType: "image/png" })
  }
  await expect
    .poll(
      async () => {
        const { runs } = (await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
        return runs[0]?.status
      },
      { timeout: 30_000 },
    )
    .toBe("succeeded")
  await expect(input).toHaveValue("Rascunho fictício preservado.")
  const { runs } = (await current.api(`/threads/${thread.id}/runs?all=true`)) as { runs: Run[] }
  const timings = runs[0]?.usage?.timings
  const observation = await page.evaluate(
    () =>
      (window as typeof window & { firstReadableObservation?: { clickAt: number; domAt: number } })
        .firstReadableObservation,
  )
  console.log("FIRST_READABLE_BROWSER", JSON.stringify({ observation, timings }))
})
