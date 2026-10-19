import { fireEvent, render, screen, within } from "@testing-library/react"
import { expect, test } from "vitest"
import capabilitySource from "../../src-tauri/capabilities/main.json?raw"
import windowConfigSource from "../../src-tauri/tauri.conf.json?raw"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

test("the main window permits title-bar dragging and native double-click zoom", () => {
  const capability = JSON.parse(capabilitySource)
  expect(capability.windows).toContain("main")
  expect(capability.permissions).toContain("core:window:allow-start-dragging")
  // The native drag-region double click uses internal_toggle_maximize, included in core:default.
  expect(capability.permissions).toContain("core:default")
})

test("the main webview delivers the first mouse click after activation", () => {
  const config = JSON.parse(windowConfigSource)
  expect(config.app.windows.find((window: { label: string }) => window.label === "main")?.acceptFirstMouse).toBe(true)
})

test("all title bars drag through decorative children while navigation and header controls remain buttons", async () => {
  const api = createMockApi()
  await api.request("POST /groups", {
    name: "Equipe",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const { container } = render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  expect(container.querySelector(".traffic-light-row")).toHaveAttribute("data-tauri-drag-region", "deep")
  expect(container.querySelector(".chat-header")).toHaveAttribute("data-tauri-drag-region", "deep")
  const bot = container.querySelector('[data-bot-entry="bot-onb"] .bot-row-main')
  if (!bot) throw new Error("Missing bot row")
  expect(bot.closest("[data-tauri-drag-region]")).toBeNull()
  fireEvent.click(bot.querySelector("strong") ?? bot)
  await screen.findByRole("textbox", { name: "Mensagem para onb" })
  fireEvent.click(within(screen.getByRole("region", { name: "Grupos" })).getByRole("button", { name: "Equipe" }))
  await screen.findByRole("textbox", { name: "Mensagem para Equipe" })
  expect(container.querySelector(".group-header")).toHaveAttribute("data-tauri-drag-region", "deep")
  const edit = screen.getByRole("button", { name: "Editar grupo", exact: true })
  expect(edit).not.toHaveAttribute("data-tauri-drag-region")
  fireEvent.click(edit)
  expect(screen.getByRole("dialog", { name: "Editar grupo" })).toBeVisible()
})
