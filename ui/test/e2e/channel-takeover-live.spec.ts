import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type BrowserContext, type BrowserContextOptions, expect, type Locator, type Page } from "@playwright/test"
import { type BrowserMeasurement, startBrowserPerformanceMeasurement } from "./channel-browser-performance"
import { test } from "./production-fixture"

test.use({ channel: "chromium", reducedMotion: "reduce", video: "off" })

// Keep recorder work outside the application frame budget.
const fluidityTest = test.extend({ trace: "off" })

const recordingContexts = new Set<BrowserContext>()

test.afterEach(async () => {
  await Promise.all(Array.from(recordingContexts, (context) => context.close()))
  recordingContexts.clear()
})

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport })

    test("the requester and another channel member see the live page through wait, control and handback", async ({
      browser,
      baseURL,
    }, info) => {
      test.setTimeout(120_000)
      if (!baseURL) throw new Error("Browser fixture base URL is missing")
      // Record video only when evidence is requested; measured contexts keep recording disabled.
      const directory = process.env.TOURI_E2E_EVIDENCE_DIR
      const recordingOptions: BrowserContextOptions = directory
        ? { recordVideo: { dir: info.outputPath("videos"), size: viewport } }
        : {}
      const context = await browser.newContext(
        Object.assign(
          {
            baseURL,
            viewport,
            reducedMotion: "reduce",
            colorScheme: "dark",
          },
          recordingOptions,
        ),
      )
      recordingContexts.add(context)
      const { requester, member, card, memberCard, control } = await openLiveBrowserPages(context)
      await expect(memberCard.getByRole("button", { name: "Assumir", exact: true })).toHaveCount(0)
      await saveEvidence(requester, "requester-wait", info.outputPath("requester-wait.png"))
      await saveEvidence(member, "member-wait", info.outputPath("member-wait.png"))

      await card.getByRole("button", { name: "Assumir", exact: true }).click()

      await expect(control).toBeVisible()
      await expect(control.getByRole("application")).toBeVisible()
      await expect(control.locator("canvas:visible, img").first()).toBeVisible()
      await expect(control.getByRole("button", { name: "Cancelar", exact: true })).toBeVisible()
      await expect(member.locator(".channel-chip")).toContainText("Ana está no controle")
      await expect(memberCard.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
      await expect(memberCard.locator(".browser-activity-chrome")).toContainText("estadias.example.test")
      await saveEvidence(requester, "requester-control", info.outputPath("requester-control.png"))
      await saveEvidence(member, "member-control", info.outputPath("member-control.png"))

      await control.getByRole("button", { name: "Devolver para Léo" }).click()

      await expect(control).toHaveCount(0)
      await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
      await expect(memberCard.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
      await expect(member.locator(".channel-chip")).not.toContainText("Ana está no controle")
      await saveEvidence(requester, "requester-handback", info.outputPath("requester-handback.png"))
      await saveEvidence(member, "member-handback", info.outputPath("member-handback.png"))
      await requester.close()
      await member.close()
      if (!directory) return

      await requester.video()?.saveAs(join(directory, `requester-${viewport.width}.webm`))
      await member.video()?.saveAs(join(directory, `member-${viewport.width}.webm`))
    })

    test("the channel header stays still while another person controls the browser", async ({ context }) => {
      const { member, card, control } = await openLiveBrowserPages(context, true)
      const header = member.locator(".group-header.channel-mode")
      const initialHeight = await header.evaluate((element) => element.getBoundingClientRect().height)

      await card.getByRole("button", { name: "Assumir", exact: true }).click()

      await expect(control).toBeVisible()
      await expect(header.getByRole("status")).toContainText("Ana está no controle")
      await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight)

      await control.getByRole("button", { name: "Devolver para Léo", exact: true }).click()

      await expect(control).toHaveCount(0)
      await expect(header.getByRole("status")).not.toContainText("Ana está no controle")
      await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight)
    })

    fluidityTest.describe("fluidity", () => {
      fluidityTest("live browser handoffs preserve the frame budget", async ({ context, trace }, info) => {
        fluidityTest.setTimeout(120_000)
        expect(trace).toBe("off")

        const { requester, member, card, control } = await openLiveBrowserPages(context)
        const takeOver = card.getByRole("button", { name: "Assumir", exact: true })
        const handBack = control.getByRole("button", { name: "Devolver para Léo", exact: true })
        const memberHeader = member.locator(".group-header")
        const initialHeaderHeight = await memberHeader.evaluate((header) => header.getBoundingClientRect().height)
        await expect(takeOver).toHaveCount(1)
        await takeOver.click()
        await expect(control).toBeVisible()
        await expect
          .poll(() => memberHeader.evaluate((header) => header.getBoundingClientRect().height))
          .toBe(initialHeaderHeight)
        await handBack.click()
        await expect(control).toHaveCount(0)
        await requester.bringToFront()
        await startPerformanceMeasurement(requester)
        await startPerformanceMeasurement(member)
        // Keep measurements in input order; each transition finishes before the next starts.
        const interactions: number[] = []
        for (const _iteration of Array.from({ length: 12 })) {
          interactions.push(await measureBrowserInteraction(takeOver))
          await expect(control).toBeVisible()
          await expect
            .poll(() => memberHeader.evaluate((header) => header.getBoundingClientRect().height))
            .toBe(initialHeaderHeight)
          interactions.push(await measureBrowserInteraction(handBack))
          await expect(control).toHaveCount(0)
        }
        const metrics = {
          viewport,
          p95Ms: getP95(interactions),
          interactionMs: interactions,
          requester: await getPerformanceMeasurement(requester),
          member: await getPerformanceMeasurement(member),
        }
        await info.attach("browser-fluidity", { body: JSON.stringify(metrics), contentType: "application/json" })
        if (process.env.TOURI_E2E_EVIDENCE_DIR)
          await writeFile(
            join(process.env.TOURI_E2E_EVIDENCE_DIR, `fluidity-${viewport.width}.json`),
            JSON.stringify(metrics),
          )

        expect(metrics.p95Ms).toBeLessThan(100)
        expect(metrics.requester.events.length).toBeGreaterThan(0)
        expect(getP95(metrics.requester.events)).toBeLessThan(100)
        expect(metrics.requester.longTasks).toEqual([])
        expect(metrics.member.longTasks).toEqual([])
        expect(metrics.requester.cls).toBeLessThan(0.01)
        expect(metrics.member.cls).toBeLessThan(0.01)
      })
    })
  })
}

const openLiveBrowserPages = async (context: BrowserContext, channelMode = false) => {
  const requester = await context.newPage()
  const member = await context.newPage()
  const mode = channelMode ? "&channelMode=1" : ""
  await requester.goto(`/test/e2e/channel-browser-harness.html?viewer=user-ana&workflow=1${mode}`)
  await member.goto(`/test/e2e/channel-browser-harness.html?viewer=user-hugo&workflow=1${mode}`)
  const card = requester.locator(".browser-activity-card")
  const memberCard = member.locator(".browser-activity-card")
  const control = requester.locator(".browser-takeover-view")
  await expect(card).toHaveAttribute("data-held", "true")
  await expect(memberCard).toHaveAttribute("data-held", "true")
  await expect(card.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  await expect(memberCard.getByRole("img", { name: "Página atual do navegador" })).toBeVisible()
  await requester.evaluate(() => document.fonts.ready)
  await member.evaluate(() => document.fonts.ready)

  return { requester, member, card, memberCard, control }
}

const saveEvidence = async (page: Page, name: string, output: string): Promise<void> => {
  const screenshot = await page.screenshot({ animations: "disabled", fullPage: true })
  await writeFile(output, screenshot)
  const directory = process.env.TOURI_E2E_EVIDENCE_DIR
  if (!directory) return

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${name}-${page.viewportSize()?.width}.png`), screenshot)
}

type MeasurementWindow = Window & {
  getBrowserMeasurement?: () => BrowserMeasurement
  nextBrowserPaint?: Promise<number>
}

const startPerformanceMeasurement = (page: Page): Promise<void> => page.evaluate(startBrowserPerformanceMeasurement)

const getPerformanceMeasurement = (page: Page): Promise<BrowserMeasurement> =>
  page.evaluate(() => {
    const result = (window as MeasurementWindow).getBrowserMeasurement?.()
    if (!result) throw new Error("Browser measurement was not started")

    return result
  })

const measureBrowserInteraction = async (button: Locator): Promise<number> => {
  await button.scrollIntoViewIfNeeded()
  const bounds = await button.boundingBox()
  if (!bounds) throw new Error("Browser control is not laid out")

  await button.evaluate((element) => {
    const fixture = window as MeasurementWindow
    fixture.nextBrowserPaint = new Promise<number>((resolve) => {
      element.addEventListener(
        "click",
        () => {
          const startedAt = performance.now()
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - startedAt)))
        },
        { once: true },
      )
    })
  })

  await button.page().mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)

  return button.page().evaluate(() => (window as MeasurementWindow).nextBrowserPaint ?? 0)
}

const getP95 = (samples: number[]): number =>
  samples.toSorted((first, second) => first - second)[Math.ceil(samples.length * 0.95) - 1] ?? 0
