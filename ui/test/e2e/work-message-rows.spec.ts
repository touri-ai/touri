import { join } from "node:path"
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"
import type { BotGroup, Message, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

const saveEvidence = async (page: Page, testInfo: TestInfo) => {
  const directory = process.env.TOURI_WORK_EVIDENCE_DIR
  if (!directory) return

  const phase = process.env.TOURI_WORK_EVIDENCE_PHASE ?? "after"
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        localStorage.setItem("touri.appearance.v1", value)
        document.documentElement.dataset.theme = value
        document.documentElement.classList.toggle("dark", value === "dark")
      }, theme)
      await page.evaluate(() => document.fonts.ready)
      const filename = `${phase}-${width}-${theme}.png`
      const path = join(directory, filename)
      await page.screenshot({ path, animations: "disabled" })
      await testInfo.attach(filename, { path, contentType: "image/png" })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

const getBox = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error("Element has no layout box")

  return box
}

test("Work message rows put your messages at the end and bots beside their avatar", async ({ page }, testInfo) => {
  const current = await createWorkGoldenServer()
  server = current
  await current.api("/bots", "POST", {
    name: "Lia",
    provider: "codex",
    access: "read-only",
    approvals: "on-request",
  })

  await current.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("button", { name: "Novo canal", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Criar canal", exact: true })
  await dialog.getByLabel("Nome do canal").fill("Planejamento")
  await dialog.getByRole("checkbox", { name: "Lia", exact: true }).check()
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/groups") && response.request().method() === "POST",
  )
  await dialog.getByRole("button", { name: "Criar canal", exact: true }).click()
  const { thread } = (await (await created).json()) as { group: BotGroup; thread: Thread }
  const messages = page.getByTestId("virtual-message-list")
  const input = page.getByRole("textbox", { name: /Mensagem (?:para |em #)Planejamento/ })
  const send = async (text: string) => {
    await input.fill(text)
    const accepted = page.waitForResponse(
      (response) => /\/threads\/[^/]+\/messages$/.test(response.url()) && response.request().method() === "POST",
    )
    await input.press("Enter")
    expect((await accepted).ok()).toBe(true)
  }

  await send("Mensagem inicial de exemplo.")
  await expect(messages.getByText("Mensagem inicial de exemplo.", { exact: true })).toBeVisible()
  await send("@Lia confira o plano.")
  await expect(messages.getByText("Plano conferido. Podemos continuar.", { exact: true })).toBeVisible()
  await page.mouse.move(0, 0)
  await saveEvidence(page, testInfo)

  const history = (await current.api(`/threads/${thread.id}/messages`)) as { messages: Message[] }
  const firstOwnerMessage = history.messages.find((message) => message.text === "Mensagem inicial de exemplo.")
  const secondOwnerMessage = history.messages.find((message) => message.text === "@Lia confira o plano.")
  const botMessage = history.messages.find((message) => message.role === "assistant")
  if (!firstOwnerMessage || !secondOwnerMessage || !botMessage) throw new Error("Synthetic conversation is incomplete")

  const getRow = (message: Message) => messages.locator(`[data-message-row="${message.id}"] > .message-bubble`)
  const firstOwnerRow = getRow(firstOwnerMessage)
  const secondOwnerRow = getRow(secondOwnerMessage)
  const botRow = getRow(botMessage)

  // Your own message: a compact bubble at the end, without avatar, name or header.
  await expect(firstOwnerRow).toHaveAttribute("data-message-author", "own")
  await expect(firstOwnerRow.locator(".tb-avatar, .message-meta, .message-role")).toHaveCount(0)
  const ownBubble = await getBox(firstOwnerRow.locator(".message-body"))
  const ownColumn = await getBox(botRow)
  expect(Math.abs(ownBubble.x + ownBubble.width - (ownColumn.x + ownColumn.width))).toBeLessThanOrEqual(1)
  expect(ownBubble.width).toBeLessThan(ownColumn.width / 2)
  expect(
    await firstOwnerRow.locator(".message-body").evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)")

  // The time waits in the action row until hover.
  const ownTime = firstOwnerRow.locator(".message-actions time")
  await expect(ownTime).toHaveCSS("opacity", "0")
  await firstOwnerRow.locator(".message-body").hover()
  await expect(ownTime).toHaveCSS("opacity", "1")
  await page.mouse.move(0, 0)

  // A continuation by the same author draws no header of its own.
  await expect(secondOwnerRow).toHaveAttribute("data-message-grouped", "true")
  await expect(secondOwnerRow.locator(".tb-avatar, .message-meta")).toHaveCount(0)

  // The bot: avatar column, name above, text bubble with the avatar bottom-aligned to it.
  await expect(botRow).toHaveAttribute("data-message-author", "bot")
  await expect(botRow.locator(".message-meta .message-role")).toHaveText("Lia")
  const avatar = await getBox(botRow.locator(".message-avatar .tb-avatar"))
  const name = await getBox(botRow.locator(".message-meta"))
  const body = await getBox(botRow.locator(".message-body"))
  expect(Math.round(avatar.width)).toBe(28)
  expect(avatar.x + avatar.width).toBeLessThanOrEqual(name.x)
  expect(Math.abs(body.x - name.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(avatar.y + avatar.height - (body.y + body.height))).toBeLessThanOrEqual(1)
  expect(body.x).toBeLessThan(ownBubble.x)
  expect(
    await botRow
      .locator(".message-text")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)")
  const botTime = botRow.locator(".message-meta time")
  await expect(botTime).toHaveCSS("opacity", "0")
  await botRow.locator(".message-body").hover()
  await expect(botTime).toHaveCSS("opacity", "1")

  await page.setViewportSize({ width: 390, height: 844 })
  const phoneBubble = await getBox(firstOwnerRow.locator(".message-body"))
  const phoneColumn = await getBox(botRow)
  expect(Math.abs(phoneBubble.x + phoneBubble.width - (phoneColumn.x + phoneColumn.width))).toBeLessThanOrEqual(1)
  expect(Math.round((await getBox(botRow.locator(".message-avatar .tb-avatar"))).width)).toBe(28)
})
