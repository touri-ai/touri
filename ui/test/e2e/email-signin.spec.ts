import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"
import { pairingPageHtml } from "../../../sidecar/src/cli/web/pairingPage"

const languages = [
  {
    locale: "pt-BR",
    progress: "Conectando este dispositivo…",
    invalid: "Este link é inválido, expirou ou já foi usado. Peça outro link.",
    offline: "Não foi possível falar com o servidor. Confira a conexão e tente novamente.",
    email: "E-mail",
    send: "Enviar link de acesso",
    sent: "Se este endereço tiver acesso, enviaremos um link por e-mail.",
  },
  {
    locale: "en-US",
    progress: "Connecting this device…",
    invalid: "This link is invalid, expired, or already used. Request another one.",
    offline: "Could not reach the server. Check your connection and try again.",
    email: "Email",
    send: "Send sign-in link",
    sent: "If this address has access, a sign-in link will arrive by email.",
  },
] as const
const themes = ["light", "dark"] as const

languages.forEach((language) => {
  test.describe(`email sign-in: ${language.locale}`, () => {
    test.use({ locale: language.locale })

    themes.forEach((theme) => {
      test(`expired link recovers in ${theme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme })
        await openSignInPage(page)
        const redemption = page.waitForRequest("**/api/v1/auth/email/redeem")
        const release = getReleaseSignal()
        await page.route("**/api/v1/auth/email/redeem", async (route) => {
          await release.promise
          await route.fulfill({ status: 401, json: { errorCode: "INVALID_SIGN_IN" } })
        })

        await page.goto("/login#signin=expired-example-token")
        const request = await redemption

        expect(request.postDataJSON()).toMatchObject({ token: "expired-example-token" })
        await expect(page).toHaveURL(/\/login$/u)
        await saveEvidence(page, `${language.locale}-${theme}-progress`)
        await expect(page.getByRole("status")).toHaveText(language.progress)
        await expect(page.getByRole("status")).toBeVisible()

        release.resolve()

        await expect(page.getByRole("status")).toHaveText(language.invalid)
        await saveEvidence(page, `${language.locale}-${theme}-expired`)
        await expect(page.getByRole("status")).toBeVisible()
        await expect(page.getByLabel(language.email, { exact: true })).toBeFocused()
        await expect(page.locator("#pair-form")).toBeVisible()
        const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()

        expect(audit.violations).toEqual([])

        await page.route("**/api/v1/auth/email", (route) => route.fulfill({ status: 202, json: { ok: true } }))
        await page.getByLabel(language.email, { exact: true }).fill("member@example.test")
        await page.getByRole("button", { name: language.send, exact: true }).click()

        await expect(page.getByRole("status")).toHaveText(language.sent)
      })
    })

    test("connection failure restores the sign-in controls", async ({ page }) => {
      await openSignInPage(page)
      await page.route("**/api/v1/auth/email/redeem", (route) => route.abort("connectionfailed"))

      await page.goto("/login#signin=example-token")

      await expect(page.getByRole("status")).toHaveText(language.offline)
      await expect(page.getByRole("status")).toBeVisible()
      await expect(page.getByLabel(language.email, { exact: true })).toBeFocused()
      await expect(page.locator("#pair-form")).toBeVisible()
      await expect(page).toHaveURL(/\/login$/u)
    })

    test("a stalled redemption times out and restores the sign-in controls", async ({ page }) => {
      await openSignInPage(page)
      await page.clock.install()
      await page.route("**/api/v1/auth/email/redeem", () => {})
      const redemption = page.waitForRequest("**/api/v1/auth/email/redeem")

      await page.goto("/login#signin=example-token")
      await redemption
      await page.clock.fastForward(15_001)

      await expect(page.getByRole("status")).toHaveText(language.offline)
      await expect(page.getByRole("status")).toBeVisible()
      await expect(page.getByLabel(language.email, { exact: true })).toBeFocused()
      await expect(page.locator("#pair-form")).toBeVisible()
    })

    test("successful redemption opens the app without the token", async ({ page }) => {
      await openSignInPage(page)
      await page.route("**/api/v1/auth/email/redeem", (route) =>
        route.fulfill({ json: { ok: true, deviceId: "example-device" } }),
      )
      await page.route("**/", (route) => route.fulfill({ contentType: "text/html", body: "<main>touri</main>" }))

      await page.goto("/login#signin=example-token")

      await expect(page).toHaveURL(/\/$/u)
      await expect(page.getByRole("main")).toHaveText("touri")
    })
  })
})

const openSignInPage = (page: Page) =>
  page.route("**/login", (route) => route.fulfill({ contentType: "text/html", body: pairingPageHtml }))

const getReleaseSignal = () => {
  // The Promise constructor provides the completion callback synchronously.
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })

  return { promise, resolve: release }
}

const saveEvidence = async (page: Page, name: string): Promise<void> => {
  const directory = process.env.TOURI_SIGNIN_EVIDENCE_DIR
  if (!directory) return

  await page.screenshot({ path: `${directory}/${name}.png` })
}
