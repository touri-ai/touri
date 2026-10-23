import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { openBotActions, showBotAdvanced, showBotRoutines } from "./home-navigation"
import budgets from "./ui-budget.json" with { type: "json" }

type Screen = keyof typeof budgets
const widths = [1440, 1024, 390]
const getSidebar = (page: Page) => page.locator("nav.bot-sidebar")
const getWorkspace = (page: Page) => page.locator(".workspace-page")

for (const { width, theme } of widths.flatMap((width) => ["light", "dark"].map((theme) => ({ width, theme })))) {
  for (const screen of Object.keys(budgets) as Screen[]) {
    if (screen === "phone-drawer" && width !== 390) continue

    test(`UI budget: ${screen} at ${width}px in ${theme}`, async ({ page }, info) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((appearance) => {
        localStorage.setItem("touri.appearance.v1", appearance)
        localStorage.setItem("touri.sidebar.mode", "bots")
      }, theme)
      await page.goto(
        `/test/e2e/ui-budget-harness.html${["needs-you-signals", "approval-card", "bell"].includes(screen) ? "?approval" : ""}`,
      )
      await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible({ timeout: 60_000 })
      const root = await openScreen(page, screen, width)
      await expect(root).toBeVisible({ timeout: 30_000 })
      await waitForScreen(root, screen)
      await page.evaluate(() => document.fonts.ready)
      const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
      await mkdir(directory, { recursive: true })
      const screenshot = join(directory, `${screen}-${width}-${theme}.png`)
      await page.screenshot({ path: screenshot, animations: "disabled" })
      await info.attach(`${screen}-${width}`, { path: screenshot, contentType: "image/png" })

      if (["bots-sidebar", "bot-row-click", "work-sidebar", "phone-drawer"].includes(screen)) {
        for (const row of await root.locator(".sidebar-row").all()) {
          const rowControls = row.locator(
            "button, a[href], input, textarea, select, [role=button], [role=link], [role=checkbox], [role=combobox], [role=menuitem]",
          )
          const count = await rowControls.count()
          expect(
            count,
            `${screen} (${width}px): a list row has extra controls: ${await row.innerText()}`,
          ).toBeLessThanOrEqual(2)
          if (count === 2) await expect(rowControls.last()).toHaveAttribute("aria-haspopup", "menu")
        }
      }
      const controls = await getControls(root, screen)
      expect(
        controls.every((control) => control.trim().length > 0),
        `${screen}: identify every control`,
      ).toBe(true)
      const budget = budgets[screen].maxControls
      await writeFile(
        join(directory, `${screen}-${width}-${theme}.json`),
        JSON.stringify({ screen, width, budget, controls }, null, 2),
      )
      expect(
        controls.length,
        `${screen} (${width}px): ${controls.length} visible enabled controls; budget ${budget}. Extra controls: ${controls.slice(budget).join(" | ")}. Inventory: ${controls.join(" | ")}`,
      ).toBeLessThanOrEqual(budget)
      if (screen === "channel-members") {
        const padding = await root
          .locator(".bot-panel-body")
          .evaluate((body) => Number.parseFloat(getComputedStyle(body).paddingLeft))
        expect(padding).toBeGreaterThanOrEqual(12)
        await expect(root.getByText("Resultados do turno", { exact: true })).toHaveCount(0)
        for (const member of await root.locator(".group-context-members li").all()) {
          await expect(member.locator("strong")).toHaveCount(1)
          expect(await member.locator("strong, small, .group-member-state").count()).toBeLessThanOrEqual(2)
        }
      }
      if (screen === "bell") {
        for (const row of await root.locator(".notification-row").all()) {
          expect(await getControls(row, "approval-card"), "one visible primary action per notification").toHaveLength(1)
        }
        await expect(root.getByRole("button", { name: "Tarefas interrompidas", exact: true })).toHaveCount(0)
      }
      if (screen === "tool-activity") {
        await root.locator(".turn-activity-toggle").click()
        await expect(root.locator(".turn-activity-step")).toHaveCount(3)
        expect(await getControls(root, screen)).toHaveLength(2)
        await expect(root.locator(".tool-input").first()).toBeHidden()
        const expanded = join(directory, `tool-activity-expanded-${width}-${theme}.png`)
        await page.screenshot({ path: expanded, animations: "disabled" })
        await info.attach(`tool-activity-expanded-${width}`, { path: expanded, contentType: "image/png" })
      }
    })
  }
}

const openDrawer = async (page: Page, width: number) => {
  if (width !== 390 || (await getSidebar(page).isVisible())) return
  await page.getByRole("button", { name: "Abrir menu", exact: true }).click()
}

const openChannel = async (page: Page, width: number, name = "Viagens") => {
  await openDrawer(page, width)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await getSidebar(page)
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click()
  await expect(page.locator(".group-header")).toContainText(name)
}

const openScreen = async (page: Page, screen: Screen, width: number): Promise<Locator> => {
  if (
    [
      "bots-sidebar",
      "bot-row-click",
      "bot-menu",
      "bot-settings",
      "new-bot",
      "advanced-menu",
      "app-settings",
      "work-sidebar",
      "channel-row-menu",
      "routines",
      "phone-drawer",
    ].includes(screen)
  )
    await openDrawer(page, width)
  if (["bots-sidebar", "phone-drawer"].includes(screen)) return getSidebar(page)
  if (screen === "bot-row-click") {
    const before = await getControls(getSidebar(page), screen)
    await page.locator('[data-bot-entry="bot-onb"] .bot-row-main').click()
    await expect(page.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
    await openDrawer(page, width)
    expect(await getControls(getSidebar(page), screen)).toHaveLength(before.length)
    await expect(getSidebar(page).locator(".bot-thread-tree")).toHaveCount(0)
    return getSidebar(page)
  }
  if (screen === "composer") {
    await page.locator("form.composer textarea").fill("Confira o plano, por favor.")
    return page.locator("form.composer")
  }
  if (screen === "tool-activity") {
    const activity = page.locator(".turn-activity").last()
    await activity.scrollIntoViewIfNeeded()
    return activity
  }
  if (screen === "dm") {
    await openDrawer(page, width)
    await page.getByRole("tab", { name: /^Work,/ }).click()
    await page.locator('[data-work-bot-entry="bot-mark"] .bot-row-main').click()
    await expect(page.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible({ timeout: 60_000 })
    return getWorkspace(page)
  }
  if (screen === "conversation") {
    await page.locator("form.composer textarea").fill("Confira o plano, por favor.")
    return getWorkspace(page)
  }
  if (screen === "bot-panel") {
    await page.getByRole("button", { name: "Painel do bot", exact: true }).click()
    return page.getByRole("complementary", { name: "Painel de mark" })
  }
  if (screen === "new-bot") {
    await page.getByRole("button", { name: "Criar bot", exact: true }).click()
    return page.getByRole("dialog").last()
  }
  if (screen === "bot-menu" || screen === "bot-settings" || screen === "routines") {
    if (screen === "bot-settings") await showBotAdvanced(page)
    else if (screen === "routines") await showBotRoutines(page)
    else await openBotActions(page)
    if (screen === "routines") return page.locator(".cron-screen")
    return page.getByRole(screen === "bot-menu" ? "menu" : "dialog").last()
  }
  if (screen === "advanced-menu") {
    await page.locator("button[aria-controls='sidebar-advanced-pages']").click()
    return page.locator("#sidebar-advanced-pages")
  }
  if (screen === "app-settings") {
    await page.locator(".user-chip").click()
    return page.getByRole("dialog").last()
  }
  if (screen === "search") {
    await page.keyboard.press("Control+k")
    return page.getByRole("dialog").last()
  }
  if (screen === "work-sidebar" || screen === "channel-row-menu") {
    await page.getByRole("tab", { name: /^Work,/ }).click()
    const rows = getSidebar(page).locator(".sidebar-row.channel-row")
    await expect(rows).toHaveCount(2)
    const geometry = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect()
        const parts = [".channel-hash", ".channel-name", ".sidebar-unread"].flatMap((selector) => {
          const part = element.querySelector(selector)
          return part?.getBoundingClientRect().height ? [part.getBoundingClientRect()] : []
        })
        return { height: bounds.height, centers: parts.map((part) => part.y + part.height / 2) }
      }),
    )
    expect(geometry.length).toBeGreaterThanOrEqual(2)
    geometry.forEach((row) => {
      expect(row.height).toBeLessThanOrEqual(40)
      expect(Math.max(...row.centers) - Math.min(...row.centers)).toBeLessThanOrEqual(2)
    })
    await expect(getSidebar(page).locator(".channel-bot-avatar")).toHaveCount(0)
    if (screen === "work-sidebar") return getSidebar(page)
    await rows.first().hover()
    await rows.first().getByRole("button", { name: /Ações/ }).click()
    return page.getByRole("menu")
  }
  if (["channel", "channel-empty", "channel-composer", "channel-edit", "channel-members", "invite"].includes(screen)) {
    await openChannel(page, width, screen === "channel-empty" ? "Engenharia" : "Viagens")
    if (screen === "channel-members" || screen === "invite") {
      await page.locator(".channel-members-button").click()
      if (screen === "channel-members") return page.locator(".group-panel")
      await page.locator(".group-panel").getByRole("button", { name: "Fechar painel do canal", exact: true }).click()
      await page.locator(".group-header-actions button[aria-haspopup='menu']").click()
      await page.getByRole("menuitem", { name: "Convidar pessoa", exact: true }).click()
      return page.getByRole("dialog").last()
    }
    if (screen === "channel-edit") {
      await page.locator(".group-header-actions button[aria-haspopup='menu']").click()
      await page.getByRole("menuitem", { name: "Editar canal", exact: true }).click()
      return page.getByRole("dialog").last()
    }
    if (screen === "channel-composer") {
      await page.locator("form.composer textarea").fill("Vamos revisar o roteiro amanhã?")
      return page.locator("form.composer")
    }
    return getWorkspace(page)
  }
  if (screen === "approval-card") {
    await openDrawer(page, width)
    await page.locator(".sidebar-needs-you").click()
    return page.locator(".approval-card").first()
  }
  if (screen === "needs-you-signals") {
    await openDrawer(page, width)
    return page.locator("body")
  }
  if (screen === "bell") {
    await openDrawer(page, width)
    await page.locator(".notification-bell").click()
    return page.locator(".notification-popover")
  }
  return page.locator("body")
}

const waitForScreen = async (root: Locator, screen: Screen): Promise<void> => {
  if (screen === "app-settings") {
    await expect(root.getByRole("tab", { name: "Aparência", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(root.getByRole("combobox", { name: "Tema", exact: true })).toBeVisible()
    return
  }
  if (["bot-settings", "new-bot", "channel-edit", "invite"].includes(screen)) {
    await expect(root.getByRole("textbox").first()).toBeVisible({ timeout: 30_000 })
    if (screen === "bot-settings")
      await expect(root.getByRole("button", { name: "Salvar configurações", exact: true })).toBeVisible()
    if (screen === "channel-edit") await expect(root.getByRole("checkbox")).toHaveCount(6)
    if (screen === "invite") {
      await expect(root.getByRole("button", { name: "# Viagens", exact: true })).toBeVisible()
      await expect(root.getByRole("button", { name: "# Engenharia", exact: true })).toBeVisible()
    }
    return
  }
  if (["conversation", "composer", "dm"].includes(screen)) {
    await expect(root.page().getByRole("table").last()).toBeVisible({ timeout: 30_000 })
    return
  }
  if (screen === "channel-members") {
    await expect(root.getByText("Ana", { exact: true })).toBeVisible({ timeout: 30_000 })
    return
  }
  if (screen === "routines") {
    await expect(root.locator(".routine-item")).toHaveCount(3, { timeout: 30_000 })
    return
  }
  if (screen === "search") {
    await expect(root.getByRole("combobox")).toBeVisible({ timeout: 30_000 })
    return
  }
  if (screen === "needs-you-signals") {
    await expect(root.locator(".sidebar-needs-you")).toBeVisible()
    await expect(root.locator(".notification-bell .notification-badge")).toHaveText("1")
  }
}

const getControls = (root: Locator, screen: Screen): Promise<string[]> =>
  root.evaluate((element, surface) => {
    if (surface === "needs-you-signals") {
      return Array.from(
        element.querySelectorAll<HTMLElement>(
          ".sidebar-needs-you, .notification-bell .notification-badge, .sidebar-mode-tabs .sidebar-unread[data-tone=attention], .sidebar-approval-badge, .sidebar-attention-button, .approval-notice, .approval-banner",
        ),
      )
        .filter((signal) => {
          const bounds = signal.getBoundingClientRect()
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            getComputedStyle(signal).display !== "none" &&
            getComputedStyle(signal).visibility !== "hidden"
          )
        })
        .map((signal) => signal.className)
    }
    const sidebarOnly = ["bots-sidebar", "bot-row-click", "work-sidebar", "phone-drawer"].includes(surface)
    const candidates = element.querySelectorAll<HTMLElement>(
      "button, a[href], input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=textbox], [role=combobox], [role=menuitem], [role=checkbox], [role=tab], [role=switch], [role=radio]",
    )
    return Array.from(candidates)
      .filter((control) => {
        if (control.closest("[inert], [aria-hidden=true]")) return false
        if (control.matches(":disabled, [aria-disabled=true]")) return false
        if (control.matches(".mobile-menu-button")) return false
        if (sidebarOnly && control.closest(".sidebar-row, .group-row")) return false
        // Drawer chrome has its own screen and budget; shared sidebar screens measure the same app controls.
        if (sidebarOnly && surface !== "phone-drawer" && control.matches(".sidebar-close")) return false
        if (["conversation", "dm", "channel", "channel-empty"].includes(surface) && control.closest(".turn-activity"))
          return false
        if (control.closest(".markdown-content")) return false
        if (surface === "routines" && control.closest(".routine-item")) return false
        if (surface === "bell" && control.closest(".notification-row")) return false
        const bounds = control.getBoundingClientRect()
        const style = getComputedStyle(control)
        const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        if (!target || !control.contains(target)) return false
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0"
        )
      })
      .map((control) => {
        const labelledBy = (control.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(" ")
        const labels = control instanceof HTMLInputElement ? Array.from(control.labels ?? []) : []
        const label = labels.map((element) => element.textContent?.trim()).join(" ")
        return (
          control.getAttribute("aria-label") ||
          labelledBy ||
          label ||
          control.getAttribute("placeholder") ||
          control.textContent?.trim().replace(/\s+/g, " ") ||
          `${control.tagName.toLowerCase()}${control.id ? `#${control.id}` : ""}`
        )
      })
  }, screen)

for (const width of widths) {
  test(`browser activity shares one disclosure at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto("/test/e2e/ui-budget-harness.html?browser")
    const card = page.getByRole("article", { name: "Navegador do mark", exact: true })
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(page.locator(".turn-activity-toggle")).toHaveCount(0)
    await card.scrollIntoViewIfNeeded()
    expect(await getControls(card, "tool-activity")).toHaveLength(budgets["tool-activity"].maxControls)
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR ?? info.outputDir
    await mkdir(directory, { recursive: true })
    const screenshot = join(directory, `browser-activity-${width}.png`)
    await page.screenshot({ path: screenshot, animations: "disabled" })
    await info.attach(`browser-activity-${width}`, { path: screenshot, contentType: "image/png" })
  })
}
