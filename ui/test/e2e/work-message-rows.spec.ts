import { join } from "node:path"
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test"
import type { BotGroup, Message, Thread } from "@touri/contracts"
import { createWorkGoldenServer } from "./work-golden-server"

test.setTimeout(90_000)

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null

test.afterEach(async () => {
  await server?.dispose()
  server = null
})

const saveEvidence = async (page: Page, testInfo: TestInfo, screen = "channel") => {
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
      const filename = `${phase}-${screen}-${width}-${theme}.png`
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

test("Direct message rows keep author contrast and keyboard editing on desktop and phone", async ({
  page,
}, testInfo) => {
  const current = await createWorkGoldenServer({ withSyntheticProfile: true })
  server = current
  await current.api("/bots", "POST", {
    name: "Lia",
    provider: "codex",
    providerProfile: "synthetic",
    access: "read-only",
    approvals: "on-request",
    color: "#ffffff",
    avatarShape: "classic-none",
  })

  await current.install(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(current.serverUrl)
  const input = page.getByRole("textbox", { name: "Mensagem para Lia", exact: true })
  await input.fill("Confira o plano de exemplo.")
  await input.press("Enter")
  const messages = page.getByTestId("virtual-message-list")
  await expect(messages.getByText("Plano conferido. Podemos continuar.", { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await page.mouse.move(0, 0)
  const ownRow = messages.locator(".message-user").filter({ hasText: "Confira o plano de exemplo." })
  const botRow = messages.locator(".message-assistant").filter({ hasText: "Plano conferido. Podemos continuar." })
  await ownRow.getByRole("button", { name: "Editar", exact: true }).focus()
  await saveEvidence(page, testInfo, "direct")

  const name = botRow.locator(".message-role")
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value
      }, theme)
      for (const color of ["#ffffff", "#000000", "#ffff00", "#f0b429", "#3ecf8e", "#8b5cf6"]) {
        await botRow.evaluate((element, value) => {
          element.style.setProperty("--avatar-author-color", value)
        }, color)
        const ratio = await name.evaluate((element) => {
          const canvas = document.createElement("canvas")
          const context = canvas.getContext("2d")
          if (!context) throw new Error("Canvas context is required to resolve CSS colours")
          const getLuminance = (color: string) => {
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
            const linear = channels.map((value) => {
              const normalized = value / 255

              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
            })

            return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722
          }
          const panel = element.closest(".chat-panel")
          if (!panel) throw new Error("Message must be inside the conversation")
          const foreground = getLuminance(getComputedStyle(element).color)
          const background = getLuminance(getComputedStyle(panel).backgroundColor)

          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        })

        expect(ratio, `${theme} ${width}px author ${color}`).toBeGreaterThanOrEqual(4.5)
      }
    }
    const edit = ownRow.getByRole("button", { name: "Editar", exact: true })
    await edit.focus()
    await expect(ownRow.locator(".user-message-actions")).toHaveCSS("opacity", "1")
    await expect(ownRow.locator(".message-actions time")).toHaveCSS("opacity", "1")
    await page.keyboard.press("Enter")
    await expect(ownRow.getByRole("textbox")).toBeFocused()
    await expect(messages).toHaveJSProperty("scrollWidth", await messages.evaluate((element) => element.clientWidth))
    await ownRow.getByRole("button", { name: "Cancelar", exact: true }).click()
    await expect(edit).toBeFocused()
  }
})
