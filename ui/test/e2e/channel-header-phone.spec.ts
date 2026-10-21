import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import type { ApiRequest } from "../../src/api/client"

for (const width of [360, 390, 430]) {
  test(`channel header contains its members above scrolling messages at ${width}px`, async ({ page }) => {
    const evidence = resolve(import.meta.dirname, "../../../docs/qa/landing-bugs")
    mkdirSync(evidence, { recursive: true })
    await page.setViewportSize({ width: 1100, height: 844 })
    await page.goto("/test/e2e/groups-harness.html")
    await page.getByRole("textbox", { name: "Mensagem para mark", exact: true }).waitFor()
    await page.evaluate(async () => {
      const fixture = window as Window & {
        groupsQa?: { api: { request: ApiRequest; getState: () => { bots: Array<{ id: string }> } } }
      }
      const api = fixture.groupsQa?.api
      if (!api) throw new Error("Missing group fixture")
      const memberIds = api
        .getState()
        .bots.slice(0, 2)
        .map((bot) => bot.id)

      await api.request("POST /groups", {
        name: "Viagens",
        color: "#2563eb",
        avatarShape: "classic-none",
        memberIds,
        coordinatorBotId: null,
      })
    })
    await page
      .getByRole("region", { name: "Grupos", exact: true })
      .getByRole("button", { name: "Viagens", exact: true })
      .click()
    const composer = page.getByRole("textbox", { name: "Mensagem para Viagens" })
    await expect(composer).toBeVisible()
    await composer.fill("Vamos organizar a viagem de demonstração.")
    await composer.press("Enter")
    await page.setViewportSize({ width, height: 844 })
    const header = page.locator(".group-header")
    const members = page.locator(".group-header-members")
    await expect(members).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${evidence}/channel-header-${width}.png` })
    const headerBox = await header.boundingBox()
    const memberBox = await members.boundingBox()
    const messages = await page.locator(".message-scroll").boundingBox()
    if (!headerBox || !memberBox || !messages) throw new Error("Missing channel layout")

    expect(memberBox.y + memberBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height)
    expect(memberBox.y + memberBox.height).toBeLessThanOrEqual(messages.y)
    expect(await header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)

    await composer.fill("Mensagem fictícia para testar a rolagem do canal. ".repeat(40))
    await composer.press("Enter")
    const scroll = page.locator(".message-scroll")
    await expect.poll(() => scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await scroll.evaluate((element) => element.scrollTo(0, 0))
    const scrolledMembers = await members.boundingBox()
    const scrolledMessages = await scroll.boundingBox()
    if (!scrolledMembers || !scrolledMessages) throw new Error("Missing scrolled channel layout")

    expect(scrolledMembers.y + scrolledMembers.height).toBeLessThanOrEqual(scrolledMessages.y)
  })
}
