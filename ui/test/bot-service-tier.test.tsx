import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot, CreateBotInput } from "@touri/contracts"
import { afterEach, expect, expectTypeOf, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { BotSettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"
import { showBotSettings } from "./workspaceNavigation"

afterEach(cleanup)

const openSettings = async () => {
  showBotSettings()
  const dialog = await screen.findByRole("dialog", { name: "Configurações de mark" })
  fireEvent.click(within(dialog).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
}

it("opts in, keeps fast on unrelated save and opts out", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await openSettings()
  const toggle = screen.getByRole("switch", { name: "Modo rápido", exact: true })

  expect(toggle).not.toBeChecked()
  expect(toggle).toHaveAccessibleDescription("Respostas mais rápidas, com custo maior")
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())

  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { serviceTier: "fast" },
    pathValues: { id: "bot-mark" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await openSettings()
  const reopened = screen.getByRole("switch", { name: "Modo rápido", exact: true })
  expect(reopened).toBeChecked()

  fireEvent.click(reopened)
  await waitFor(() => expect(reopened).not.toBeChecked())

  expect(api.calls).toContainEqual({
    route: "PATCH /bots/:id",
    input: { serviceTier: null },
    pathValues: { id: "bot-mark" },
  })
})

it.each(["claude", "opencode"] as const)("hides paid fast mode for %s", (provider) => {
  const base = createMockApi().getState().bots[0]
  if (!base) throw new Error("Missing synthetic bot")
  const bot: Bot = { ...base, provider }
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      initialSection="model"
      actions={{} as WorkspaceActions}
      onClose={() => undefined}
    />,
  )

  expect(screen.queryByRole("switch", { name: "Modo rápido", exact: true })).toBeNull()
})

it.each(["local", "vm", "cloud"] as const)("offers paid fast mode only on supported execution: %s", (machine) => {
  const base = createMockApi().getState().bots[0]
  if (!base) throw new Error("Missing synthetic bot")
  const bot: Bot = { ...base, provider: "codex", machine }

  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      initialSection="model"
      actions={{} as WorkspaceActions}
      onClose={() => undefined}
    />,
  )

  expect(screen.queryAllByRole("switch", { name: "Modo rápido", exact: true })).toHaveLength(
    machine === "cloud" ? 0 : 1,
  )
})

it("reports a failed save and keeps the previous tier", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing synthetic bot")
  const updateBot = vi.fn(async () => {
    throw new Error("Synthetic failure")
  })
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      initialSection="model"
      actions={{ updateBot } as WorkspaceActions}
      onClose={() => undefined}
    />,
  )
  const toggle = screen.getByRole("switch", { name: "Modo rápido", exact: true })

  await act(async () => fireEvent.click(toggle))

  expect(screen.getByRole("alert")).toBeVisible()
  expect(toggle).not.toBeChecked()
  expect(toggle).not.toBeDisabled()
})

it("translates the price disclosure to English", () => {
  expect(t("Modo rápido", {}, "en")).toBe("Fast mode")
  expect(t("Respostas mais rápidas, com custo maior", {}, "en")).toBe("Faster responses at a higher cost")
})

it("keeps the contract optional and limited to fast or null", () => {
  expectTypeOf<Bot["serviceTier"]>().toEqualTypeOf<"fast" | null | undefined>()
  expectTypeOf<CreateBotInput["serviceTier"]>().toEqualTypeOf<Bot["serviceTier"]>()
  expectTypeOf<ApiRoutes["PATCH /bots/:id"]["req"]["serviceTier"]>().toEqualTypeOf<Bot["serviceTier"]>()
})
