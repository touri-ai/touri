import type { BrowserContext } from "@playwright/test"
import { expect, test } from "@playwright/test"
import { createPeopleInviteServer } from "./people-invite-server"

let server: Awaited<ReturnType<typeof createPeopleInviteServer>> | null = null
let memberContext: BrowserContext | null = null

test.afterEach(async () => {
  await memberContext?.close()
  memberContext = null
  await server?.dispose()
  server = null
})

test("an owner invites a person who joins in a second browser context", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000)
  const currentServer = await createPeopleInviteServer()
  server = currentServer
  const currentMemberContext = await browser.newContext({
    locale: "pt-BR",
    viewport: { width: 390, height: 844 },
  })
  memberContext = currentMemberContext

  const createdBot = (await currentServer.api("/bots", "POST", {
    name: "Léo",
    provider: "codex",
    access: "full",
    approvals: "never",
  })) as { bot: { id: string } }
  const createdGroup = (await currentServer.api("/groups", "POST", {
    name: "Vendas",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: [createdBot.bot.id],
    coordinatorBotId: null,
  })) as { group: { id: string } }

  await currentServer.install(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(currentServer.serverUrl)
  await expect(page.locator(".bot-sidebar")).toBeVisible()
  const workTab = page.getByRole("tab", { name: /Work|Trabalho/ })
  if (await workTab.count()) await workTab.click()
  await page.getByRole("button", { name: "Vendas", exact: true }).click()
  await expect(page.getByRole("textbox", { name: /Mensagem (?:para |em #)Vendas/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Convidar pessoa", exact: true }).first()).toBeVisible()
  const beforePath = testInfo.outputPath("people-invite-before.png")
  await page.screenshot({ path: beforePath })
  await testInfo.attach("people-invite-before", { path: beforePath, contentType: "image/png" })

  await page.getByRole("button", { name: "Convidar pessoa", exact: true }).first().click()
  const inviteDialog = page.getByRole("dialog", { name: "Convidar pessoa", exact: true })
  await inviteDialog.getByLabel("Nome", { exact: true }).fill("Ana Lima")

  await expect(inviteDialog.getByRole("button", { name: "# Vendas", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  const inviteResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/invites") && response.request().method() === "POST",
  )
  await inviteDialog.getByRole("button", { name: "Enviar convite", exact: true }).click()
  const inviteResponse = await inviteResponsePromise
  expect(inviteResponse.ok()).toBe(true)
  const delivery = (await inviteResponse.json()) as {
    invite: { channelIds: string[]; role: string }
    link: string
    code: string
  }
  expect(delivery.invite.channelIds).toEqual([createdGroup.group.id])
  expect(delivery.invite.role).toBe("member")
  await expect(inviteDialog.getByText(/O envio de e-mail não está configurado/)).toBeVisible()
  await expect(inviteDialog.getByRole("button", { name: "Copiar link", exact: true })).toBeVisible()
  await expect(inviteDialog.getByRole("button", { name: "Revogar", exact: true })).toBeVisible()
  const afterPath = testInfo.outputPath("people-invite-after.png")
  await page.screenshot({ path: afterPath })
  await testInfo.attach("people-invite-after", { path: afterPath, contentType: "image/png" })

  const memberPage = await currentMemberContext.newPage()
  await memberPage.emulateMedia({ reducedMotion: "reduce" })
  const joinResponse = await memberPage.goto(`${currentServer.serverUrl}/join`)
  expect(joinResponse?.status()).toBe(200)
  await expect(memberPage).toHaveURL(/\/join$/)
  await expect(memberPage.locator("h1")).toHaveText("Entrar no touri")
  await memberPage.getByLabel("Código do convite", { exact: true }).fill(delivery.code)
  await memberPage.getByLabel("Seu nome", { exact: true }).fill("Ana")
  await memberPage.getByLabel("Nome deste aparelho", { exact: true }).fill("Celular da Ana")

  const joinPath = testInfo.outputPath("people-invite-join.png")
  await memberPage.screenshot({ path: joinPath })
  await testInfo.attach("people-invite-join", { path: joinPath, contentType: "image/png" })
  await memberPage.getByRole("button", { name: "Entrar", exact: true }).click()
  await memberPage.waitForURL(`${new URL(currentServer.serverUrl).origin}/`)

  await expect(memberPage.getByRole("textbox", { name: /Mensagem (?:para |em #)Vendas/ })).toBeVisible()
  await expect(memberPage.getByRole("alert")).toHaveCount(0)
  const composer = memberPage.getByRole("textbox", { name: /Mensagem (?:para |em #)Vendas/ })
  await composer.fill("@Léo olá, pode ajudar o time?")
  const sent = memberPage.waitForResponse(
    (response) => /\/threads\/[^/]+\/messages$/.test(response.url()) && response.request().method() === "POST",
  )
  await composer.press("Enter")
  expect((await sent).ok()).toBe(true)
  await expect(memberPage.getByText("@Léo olá, pode ajudar o time?", { exact: true })).toBeVisible()
  await expect(memberPage.getByText("Olá, Ana! Posso ajudar o time.", { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(memberPage.getByRole("alert")).toHaveCount(0)
  const memberPath = testInfo.outputPath("people-invite-member.png")
  await memberPage.screenshot({ path: memberPath })
  await testInfo.attach("people-invite-member", { path: memberPath, contentType: "image/png" })
  expect(
    (await currentMemberContext.cookies(currentServer.serverUrl)).some((cookie) => cookie.name === "touri_device"),
  ).toBe(true)
})
