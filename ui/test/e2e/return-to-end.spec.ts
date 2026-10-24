import { join } from "node:path"
import { expect, test } from "@playwright/test"

test("returning to the end follows layout growth before its scroll event", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/test/e2e/r8-chat-harness.html?view=long&theme=dark")
  await page.getByRole("button", { name: "Mostrar mais", exact: true }).click()
  await page.locator(".chat-long-content .disclosure-reveal").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  await page.locator(".message-scroll").evaluate((list) => {
    list.scrollTop = 0
  })
  await page.evaluate(() => Reflect.get(window, "r8Chat").append())
  const jump = page.getByRole("button", { name: "1 nova mensagem", exact: true })
  await expect(jump).toBeVisible()
  await page.locator(".message-scroll").evaluate((list) => {
    // A disclosure can grow between the requested jump and delivery of its native scroll event.
    list.addEventListener(
      "scroll",
      () => {
        const disclosure = list.querySelector<HTMLElement>(".chat-long-content .disclosure-reveal")
        if (disclosure) disclosure.style.height = `${disclosure.getBoundingClientRect().height + 400}px`
      },
      { capture: true, once: true },
    )
  })

  await jump.click()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  const directory = process.env.TOURI_SCROLL_CAPTURE_DIR
  await page.screenshot({
    path: directory ? join(directory, "return-to-end.png") : testInfo.outputPath("return-to-end.png"),
  })

  await expect(page.locator(".message-assistant").last()).toBeInViewport()
  await expect(page.locator(".message-assistant").last().locator("strong")).toHaveText("Resposta final:")
  await expect(page.getByRole("button", { name: "Voltar ao fim", exact: true })).toHaveCount(0)
})
