import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import type { Attachment, Bot, Message, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

const phase = process.env.WORK_IMAGES_PHASE ?? "after"
for (const width of [1440, 390]) {
  test(`Work channel image evidence ${phase} ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/test/e2e/work-images-harness.html")
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page
      .getByRole("button", { name: /Capturas da equipe/ })
      .first()
      .click()
    await expect(page.getByTestId("virtual-message-list")).toBeVisible()
    await expect(
      page.getByTestId("virtual-message-list").getByText("Auditoria concluída. Captura anexada.", { exact: true }),
    ).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    if (phase === "before") await expect(page.getByRole("img", { name: "Tela do celular" })).toBeVisible()
    if (phase === "after") {
      await expect(page.locator(".evidence-thumbnail")).toHaveCount(3)
      for (const thumbnail of await page.locator(".evidence-thumbnail").all()) {
        await thumbnail.scrollIntoViewIfNeeded()
        await expect(thumbnail.locator("img")).toBeVisible()
      }
      await expect(page.locator(".evidence-thumbnail img")).toHaveCount(3)
      const attachmentWidth = await page
        .locator(".message-attachments .evidence-thumbnail")
        .first()
        .evaluate((thumbnail) => thumbnail.clientWidth)
      expect(attachmentWidth).toBeGreaterThan(200)
      expect(await page.locator("body").evaluate((body) => body.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await checkImageAccessibility(page, ".evidence-gallery")
    }
    if (width === 390) await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
    const navigation = await page.evaluate(async () => {
      const samples: number[] = []
      const longTasks: number[] = []
      const observer = new PerformanceObserver((list) =>
        list.getEntries().forEach((entry) => {
          longTasks.push(entry.duration)
        }),
      )
      observer.observe({ entryTypes: ["longtask"] })
      for (let round = 0; round < 10; round += 1) {
        for (const id of ["sidebar-mode-bots", "sidebar-mode-work"]) {
          const button = document.getElementById(id)
          if (!(button instanceof HTMLButtonElement)) throw new Error("Missing mode control")
          const started = performance.now()
          button.click()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          samples.push(performance.now() - started)
        }
      }
      observer.disconnect()

      return { samples, longTasks }
    })
    const navigationSamples = navigation.samples.toSorted((left, right) => left - right)
    const navigationP95 = navigationSamples[Math.ceil(navigationSamples.length * 0.95) - 1] ?? 0
    console.log(
      JSON.stringify({
        phase,
        width,
        interaction: "mode-channel",
        p95: navigationP95,
        longTasks: navigation.longTasks,
      }),
    )
    await testInfo.attach("mode-channel-interactions", {
      body: JSON.stringify(navigation),
      contentType: "application/json",
    })
    await page
      .getByRole("button", { name: /Capturas da equipe/ })
      .first()
      .click()
    await expect(page.getByTestId("virtual-message-list")).toBeVisible()
    const measurements = await page.evaluate(async () => {
      const samples: number[] = []
      const shifts: number[] = []
      const longTasks: number[] = []
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (entry.entryType === "longtask") longTasks.push(entry.duration)
          if (entry.entryType === "layout-shift" && "value" in entry) shifts.push(Number(entry.value))
        })
      })
      observer.observe({ entryTypes: ["longtask", "layout-shift"] })
      const getNextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      for (let index = 0; index < 20; index += 1) {
        const thumbnail = document.querySelector<HTMLButtonElement>(".evidence-thumbnail")
        if (!thumbnail) break
        const start = performance.now()
        thumbnail.click()
        await getNextFrame()
        samples.push(performance.now() - start)
        document.querySelector<HTMLButtonElement>(".evidence-lightbox header button")?.click()
        await getNextFrame()
      }
      observer.disconnect()

      return { samples, longTasks, cls: shifts.reduce((total, shift) => total + shift, 0) }
    })
    await testInfo.attach("image-interactions", { body: JSON.stringify(measurements), contentType: "application/json" })
    if (measurements.samples.length) {
      const sorted = measurements.samples.toSorted((left, right) => left - right)
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0

      console.log(JSON.stringify({ phase, width, p95, cls: measurements.cls, longTasks: measurements.longTasks }))
      expect(p95).toBeLessThan(100)
      expect(measurements.cls).toBeLessThan(0.01)
      expect(measurements.longTasks.filter((duration) => duration > 50)).toHaveLength(0)
    }
    await page.getByTestId("virtual-message-list").evaluate((history) => {
      history.scrollTop = 0
    })
    const path = process.env.TOURI_WORK_EVIDENCE_DIR
      ? `${process.env.TOURI_WORK_EVIDENCE_DIR}/${phase}-${width}.png`
      : testInfo.outputPath(`${phase}-${width}.png`)
    await page.screenshot({ path, animations: "disabled" })
    await testInfo.attach(`${phase}-${width}`, { path, contentType: "image/png" })
    if (phase !== "after") return

    await page.locator(".evidence-thumbnail").first().click()
    const lightbox = page.getByRole("dialog", { name: "visao-do-canal.png" })
    await expect(lightbox.getByRole("img")).toBeVisible()
    await checkImageAccessibility(page, ".evidence-lightbox")
    const lightboxPath = process.env.TOURI_WORK_EVIDENCE_DIR
      ? `${process.env.TOURI_WORK_EVIDENCE_DIR}/lightbox-${width}.png`
      : testInfo.outputPath(`lightbox-${width}.png`)
    await page.screenshot({ path: lightboxPath, animations: "disabled" })
    await testInfo.attach(`lightbox-${width}`, { path: lightboxPath, contentType: "image/png" })
    await page.keyboard.press("Escape")
    await expect(lightbox).not.toBeVisible()
    await expect(page.locator(".evidence-thumbnail").first()).toBeFocused()
  })
}

const checkImageAccessibility = async (page: Page, selector: string) => {
  const original = await page.evaluate(() => document.documentElement.dataset.theme ?? "dark")
  for (const theme of ["dark", "light", original]) {
    await page.evaluate((theme) => {
      localStorage.setItem("touri.appearance.v1", theme)
      window.dispatchEvent(new Event("touri:appearance"))
    }, theme)
    const audit = await new AxeBuilder({ page }).include(selector).analyze()

    expect(audit.violations).toEqual([])
  }
}

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
test.afterEach(async () => {
  await server?.dispose()
  server = null
})

test("uploaded images survive a real channel API post and history reload on phone", async ({ page }) => {
  test.skip(phase === "before", "The before capture uses the same synthetic channel without asserting new behavior")
  test.setTimeout(180_000)
  const current = await createWorkGoldenServer({ withSyntheticProfile: true })
  server = current
  const { bot } = (await current.api("/bots", "POST", {
    name: "Equipe de demonstração",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })) as { bot: Bot }
  const { thread } = (await current.api("/groups", "POST", {
    name: "Capturas enviadas",
    color: "#2563eb",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })) as { thread: Thread }
  const { attachment } = (await current.api("/attachments", "POST", {
    name: "captura-enviada.png",
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvN8AAAAASUVORK5CYII=",
  })) as { attachment: Attachment }
  await current.api(`/threads/${thread.id}/messages`, "POST", {
    threadId: thread.id,
    parentId: null,
    text: "Captura fictícia enviada pela API",
    attachmentIds: [attachment.id],
  })
  await current.install(page)
  const device = (await page.context().cookies(current.serverUrl)).find((cookie) => cookie.name === "touri_device")
  if (!device) throw new Error("Missing synthetic paired device")
  const noticeResponse = await fetch(`${current.serverUrl}/api/v1/threads/${thread.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${device.value}`,
      "Content-Type": "application/json",
      "X-Touri-Client": "touri-notify",
    },
    body: JSON.stringify({ text: "Resumo automático fictício da auditoria", attachmentIds: [attachment.id] }),
    signal: AbortSignal.timeout(15_000),
  })
  expect(noticeResponse.status).toBe(201)
  const notice = (await noticeResponse.json()) as { message: Message }
  expect(notice.message.role).toBe("assistant")
  await page.setViewportSize({ width: 390, height: 844 })

  await page.goto(current.serverUrl)
  await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page
    .getByRole("button", { name: /Capturas enviadas/ })
    .first()
    .click()
  const automatic = page
    .getByTestId("virtual-message-list")
    .locator(".message-assistant")
    .filter({ hasText: "Resumo automático fictício da auditoria" })
  await expect(automatic.getByRole("img", { name: "captura-enviada.png" })).toBeVisible()
  await page.reload()
  await expect(automatic.getByRole("img", { name: "captura-enviada.png" })).toBeVisible()
  expect(
    await automatic.evaluate((message) => {
      const text = message.querySelector(".markdown-content")
      const images = message.querySelector(".message-attachments")

      return !!text && !!images && !!(text.compareDocumentPosition(images) & Node.DOCUMENT_POSITION_FOLLOWING)
    }),
  ).toBe(true)
  await automatic.locator(".evidence-thumbnail").click()

  await expect(page.getByRole("dialog", { name: "captura-enviada.png" }).getByRole("img")).toBeVisible()
})
