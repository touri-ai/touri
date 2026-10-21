import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test"
import { createChannelHub } from "./channel-hub"
import {
  applyAction,
  canControl,
  enqueueRequest,
  getControlNotice,
  getHeaderChip,
  getInitialChannel,
  getNeedsYouTarget,
  getVisibleSnapshot,
  type MemberId,
  NEEDS_YOU_ESCALATION_MS,
  publishSnapshot,
  requestNeedsYou,
} from "./channel-state"
import { type FixtureSite, startFixtureSite } from "./fixture-server"
import { FIXTURE_LOGIN_VALUE, runScriptedBot } from "./scripted-bot"

// Two-person channel scenario (Work channels, concept/Canal): Carla owns Léo, Ana asks, Hugo watches and queues a request.
const pace = Number(process.env.CU_PACE ?? 250)
// Strict card assertions need the finished card branches, so they run with TOURI_CU_CONCEPT=1 once those are merged.
const conceptOnly = process.env.TOURI_CU_CONCEPT === "1"
const evidenceDir = process.env.CU_EVIDENCE_DIR

const variants = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", colorScheme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light", colorScheme: "light" as const },
]

let site: FixtureSite

test.beforeAll(async () => {
  site = await startFixtureSite()
})

test.afterAll(async () => {
  await site.close()
})

test.describe("channel rules", () => {
  const fresh = getInitialChannel("ana", "carla")
  const running = publishSnapshot(fresh, {
    parts: [],
    running: true,
    preview: { image: "data:image/jpeg;base64,AA==", title: "t", url: "estadias.exemplo" },
  })

  test("only the requester and the bot owner can steer the browser", () => {
    expect(canControl(fresh, "ana")).toBe(true)
    expect(canControl(fresh, "carla")).toBe(true)
    expect(canControl(fresh, "hugo")).toBe(false)
    expect(applyAction(fresh, "hugo", "takeover")).toBe(fresh)
    expect(applyAction(fresh, "hugo", "stop")).toBe(fresh)
    expect(applyAction(fresh, "ana", "takeover").controller).toBe("ana")
  })

  test("a held tab hides the preview for the whole channel and names who is in control", () => {
    const held = applyAction(running, "ana", "takeover")

    expect(getVisibleSnapshot(running).preview).toBeDefined()
    expect(getVisibleSnapshot(held).preview).toBeUndefined()
    expect(getControlNotice(held, "carla")).toBe("Ana está no controle")
    expect(getControlNotice(held, "hugo")).toBe("Ana está no controle")
    expect(getControlNotice(held, "ana")).toBe("Você está no controle")
    expect(getControlNotice(running, "carla")).toBeNull()
  })

  test("a second takeover does not steal the tab, a hand back releases it", () => {
    const held = applyAction(running, "ana", "takeover")

    expect(applyAction(held, "carla", "takeover").controller).toBe("ana")
    expect(applyAction(held, "hugo", "handback").controller).toBe("ana")
    expect(applyAction(held, "ana", "handback").controller).toBeNull()
  })

  test("needs-you goes to the requester, then to the bot owner after five minutes", () => {
    const waiting = requestNeedsYou(fresh, 1_000)

    expect(getNeedsYouTarget(fresh, 1_000)).toBeNull()
    expect(getNeedsYouTarget(waiting, 1_000 + NEEDS_YOU_ESCALATION_MS - 1)).toBe("ana")
    expect(getNeedsYouTarget(waiting, 1_000 + NEEDS_YOU_ESCALATION_MS)).toBe("carla")
    expect(getNeedsYouTarget(applyAction(waiting, "ana", "takeover"), 1_000)).toBeNull()
  })

  test("requests queue once per member and the header names the requester", () => {
    const queued = enqueueRequest(enqueueRequest(fresh, "hugo"), "hugo")

    expect(queued.queue).toEqual(["hugo"])
    expect(getHeaderChip(fresh, "Léo")).toBe("Léo no navegador · pedido da Ana")
    expect(getHeaderChip(getInitialChannel("hugo", "carla"), "Léo")).toBe("Léo no navegador · pedido do Hugo")
  })
})

const shoot = async (ui: Page, variant: string, name: string) => {
  if (!evidenceDir) return
  await mkdir(join(evidenceDir, variant), { recursive: true })
  await ui.screenshot({ path: join(evidenceDir, variant, `${name}.png`) })
}

for (const variant of variants) {
  test.describe(`channel flow: ${variant.name}`, () => {
    test.setTimeout(180_000)

    const openMember = async (browser: Browser, member: MemberId, record: boolean) => {
      const context = await browser.newContext({
        viewport: { width: variant.width, height: variant.height },
        colorScheme: variant.colorScheme,
        locale: "pt-BR",
        ...(record
          ? {
              recordVideo: {
                dir: join(evidenceDir ?? "test-results", "channel-video", variant.name, member),
                size: { width: variant.width, height: variant.height },
              },
            }
          : {}),
      })
      const page = await context.newPage()

      return { context, page, member }
    }
    const saveVideo = async (page: Page, context: BrowserContext, member: MemberId) => {
      const video = page.video()
      await page.close()
      await context.close()
      if (video) await video.saveAs(join(evidenceDir ?? "test-results", `channel-${variant.name}-${member}.webm`))
    }

    test("Ana asks, both see the live card, only Ana and Carla can take over, Hugo queues", async ({ browser }) => {
      const hub = createChannelHub("ana", "carla")
      const [carla, ana, hugo] = await Promise.all([
        openMember(browser, "carla", true),
        openMember(browser, "ana", true),
        openMember(browser, "hugo", false),
      ])
      const members = [carla, ana, hugo]
      await Promise.all(
        members.map(async ({ page, member }) => {
          await hub.attach(member, page)
          await page.goto(`/test/e2e/computer-use/channel-harness.html?theme=${variant.theme}&viewer=${member}`)
          await expect(page.getByRole("textbox", { name: "Mensagem para Léo" })).toBeVisible()
        }),
      )
      const [carlaUi, anaUi, hugoUi] = [carla.page, ana.page, hugo.page]
      const everyone = [carlaUi, anaUi, hugoUi]

      const siteContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "pt-BR" })
      const sitePage = await siteContext.newPage()
      const controlsOf = (ui: Page) => ui.locator(".cu-channel-controls")
      const cardOf = (ui: Page) => ui.locator(".browser-activity-card")
      const run = runScriptedBot({
        site: sitePage,
        siteUrl: site.url,
        pace,
        startedAt: Date.now() - 2_000,
        publish: hub.publish,
        waitForHandback: async () => {
          await expect.poll(hub.getHandbacks, { timeout: 60_000 }).toBeGreaterThan(0)
        },
        afterStep: async (index) => {
          if (index === 2) {
            await Promise.all(everyone.map((ui) => expect(cardOf(ui)).toBeVisible()))
            await Promise.all(
              everyone.map((ui) => expect(ui.getByText("Léo no navegador · pedido da Ana")).toBeVisible()),
            )
            await shoot(carlaUi, variant.name, "carla-live")
            await shoot(anaUi, variant.name, "ana-live")
          }
          if (index === 3) {
            await hugoUi
              .getByRole("textbox", { name: "Mensagem para Léo" })
              .fill("@Léo depois pesquisa Paris, por favor")
            await hugoUi.keyboard.press("Enter")
            await Promise.all(
              everyone.map((ui) => expect(ui.getByText(/Na fila do Léo: pedido do Hugo/)).toBeVisible()),
            )
            await shoot(hugoUi, variant.name, "hugo-queued")
          }
        },
      })

      // Login wall: the needs-you goes to Ana first, to Carla (bot owner) after five minutes.
      await expect(anaUi.getByText("Léo precisa de você: o site pediu login")).toBeVisible({ timeout: 60_000 })
      await expect(carlaUi.getByText("Léo chamou Ana para entrar no site")).toBeVisible()
      await expect(hugoUi.getByText("Léo chamou Ana para entrar no site")).toBeVisible()
      await shoot(anaUi, variant.name, "ana-needs-you")
      await hub.skipTime(NEEDS_YOU_ESCALATION_MS)
      await expect(carlaUi.getByText("Léo precisa de você: o site pediu login")).toBeVisible()
      await expect(anaUi.getByText("Léo chamou Carla para entrar no site")).toBeVisible()
      await hub.skipTime(0)
      await expect(anaUi.getByText("Léo precisa de você: o site pediu login")).toBeVisible()

      // Only the requester and the bot owner see the controls.
      await expect(controlsOf(anaUi).getByRole("button", { name: "Assumir" })).toBeVisible()
      await expect(controlsOf(carlaUi).getByRole("button", { name: "Assumir" })).toBeVisible()
      await expect(controlsOf(anaUi).getByRole("button", { name: "Parar" })).toBeVisible()
      await expect(controlsOf(carlaUi).getByRole("button", { name: "Parar" })).toBeVisible()
      await expect(controlsOf(hugoUi)).toHaveCount(0)

      await controlsOf(anaUi).getByRole("button", { name: "Assumir" }).click()
      await expect(anaUi.getByText("Você está no controle")).toBeVisible()
      await expect(carlaUi.getByText("Ana está no controle")).toBeVisible()
      await expect(hugoUi.getByText("Ana está no controle")).toBeVisible()
      await expect(carlaUi.getByText("A prévia está oculta para o canal enquanto Ana digita")).toBeVisible()
      // The card still shows the last frame it fetched until the take-over lane blanks it for a held tab.
      if (conceptOnly)
        await expect(cardOf(carlaUi).getByRole("img", { name: "Página atual do navegador" })).toHaveCount(0)
      await expect(controlsOf(hugoUi).getByRole("button", { name: "Devolver" })).toHaveCount(0)
      await shoot(carlaUi, variant.name, "carla-takeover-hidden")
      await shoot(anaUi, variant.name, "ana-takeover")

      // What Ana types into the site never reaches the chat, the bot or the history.
      await sitePage.getByLabel("E-mail").fill("ana@exemplo.com")
      await sitePage.getByLabel("Senha").fill(FIXTURE_LOGIN_VALUE)
      await Promise.all(everyone.map((ui) => expect(ui.locator("body")).not.toContainText(FIXTURE_LOGIN_VALUE)))
      expect(hub.getSent()).toEqual(["@Léo depois pesquisa Paris, por favor"])
      await sitePage.getByRole("button", { name: "Continuar" }).click()

      await controlsOf(anaUi).getByRole("button", { name: "Devolver" }).click()
      await expect(carlaUi.getByText("Ana está no controle")).toHaveCount(0)
      await run

      await Promise.all(
        everyone.map((ui) => expect(ui.getByRole("button", { name: /Usou o navegador/ })).toBeVisible()),
      )
      await Promise.all(everyone.map((ui) => expect(ui.getByText("Loft no West Loop")).toBeVisible()))
      await Promise.all(everyone.map((ui) => expect(ui.locator("body")).not.toContainText(FIXTURE_LOGIN_VALUE)))
      await expect(hugoUi.getByText(/Na fila do Léo: pedido do Hugo/)).toBeVisible()
      await shoot(carlaUi, variant.name, "carla-final")
      await shoot(anaUi, variant.name, "ana-final")
      const overflows = await Promise.all(
        everyone.map((ui) => ui.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)),
      )
      expect(Math.max(...overflows)).toBeLessThanOrEqual(0)

      await saveVideo(anaUi, ana.context, "ana")
      await saveVideo(carlaUi, carla.context, "carla")
      await hugo.context.close()
      await siteContext.close()
    })
  })
}
