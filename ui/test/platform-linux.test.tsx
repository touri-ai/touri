import { invoke } from "@tauri-apps/api/core"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { MachineFields } from "../src/components/MachineFields"
import { BotSettingsModal, SettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }))

vi.mock("../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform")>()),
  hostComputerSupported: false,
}))

test("Linux VM settings retain guest login and hide unsupported host control", () => {
  const { container } = render(
    <MachineFields
      values={{ machine: "vm", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false }}
      provider="codex"
      capability={{ available: true, provider: "podman", reason: null }}
      onChange={vi.fn()}
    />,
  )
  expect(container.querySelector("#machine-host-control")).toBeNull()
  expect(container.querySelector("#machine-provider-login")).not.toBeNull()
  expect(container.querySelector('option[value="vm"]')).not.toBeDisabled()
})

const renderBotSettings = async (machine: Bot["machine"]) => {
  const api = createMockApi()
  const base = api.getState().bots[0]
  if (!base) throw new Error("Missing bot fixture")
  let result!: ReturnType<typeof render>
  const settings = (await api.request("GET /settings", {})).settings
  await act(async () => {
    result = render(
      <BotSettingsModal
        bot={{ ...base, machine, browser: machine === "vm" ? "machine" : "touri" }}
        api={api}
        settings={settings}
        projects={[]}
        routines={[]}
        actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
        onClose={vi.fn()}
      />,
    )
  })
  return result
}

test.each(["local", "vm"] as const)("Linux %s bot settings gate only host computer use", async (machine) => {
  await renderBotSettings(machine)
  const dialog = screen.getByRole("dialog")
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("tab", { name: "Computador", exact: true }))
  expect(dialog.querySelector("#settings-computer-use") !== null).toBe(machine === "vm")
  expect(dialog.querySelector("#machine-host-control")).toBeNull()
  expect(dialog.querySelector("#settings-browser")).not.toBeNull()
  expect(screen.getByRole("combobox", { name: t("Bot browser") })).toBeEnabled()
})

test("Linux app preferences omit native host permissions after the settings split", async () => {
  const api = createMockApi()
  render(
    <SettingsModal
      settings={(await api.request("GET /settings", {})).settings}
      initialSection="privacy"
      onClose={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByText("Dados, permissões e conexões"))
  expect(screen.getByRole("dialog").querySelector(".settings-computer-permissions")).toBeNull()
  expect(invoke).not.toHaveBeenCalledWith("permissions_status")
})
