import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotBrowserPicker } from "../src/components/BotBrowserPicker"
import { BotSettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  localStorage.clear()
})
const Picker = ({ machine = "local" }: { machine?: Bot["machine"] }) => {
  const [browser, setBrowser] = useState<Bot["browser"]>(machine === "vm" ? "machine" : "touri")
  return <BotBrowserPicker value={browser} machine={machine} onChange={setBrowser} />
}

it("defaults to touri and explains local Chrome once while keeping the setup steps visible", () => {
  const first = render(<Picker />)
  const picker = screen.getByRole("combobox", { name: "Navegador do bot" })
  expect(picker).toHaveValue("touri")
  expect(screen.queryByRole("note")).toBeNull()
  fireEvent.change(picker, { target: { value: "local" } })
  expect(screen.getByRole("note")).toHaveTextContent("sessões já conectadas, em uma janela separada")
  expect(screen.getByRole("note")).toHaveTextContent("fechar essa janela ou apertar Parar")
  expect(screen.getByText("chrome://inspect/#remote-debugging")).toBeVisible()
  expect(screen.getByText("Permita a depuração remota.")).toBeVisible()
  expect(screen.getByText("Aceite o pedido de permissão do Chrome quando o bot conectar.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Entendi" }))
  expect(screen.queryByRole("note")).toBeNull()
  first.unmount()
  render(<Picker />)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "local" } })
  expect(screen.queryByRole("note")).toBeNull()
  expect(screen.getByText("chrome://inspect/#remote-debugging")).toBeVisible()
})

it("disables host browsers for VM bots and explains why Meu Chrome cannot be used", () => {
  render(<Picker machine="vm" />)
  expect(screen.getByRole("combobox")).toHaveValue("machine")
  expect(screen.getByRole("option", { name: "Meu Chrome" })).toBeDisabled()
  expect(screen.getByRole("option", { name: "Chrome do touri" })).toBeDisabled()
  expect(screen.getByText(/máquina remota não pode acessar o Chrome do computador/)).toBeVisible()
})

it("provides English labels and a localized public error", () => {
  expect(t("My Chrome", {}, "en")).toBe("My Chrome")
  expect(t("Machine Chrome", {}, "en")).toBe("Machine Chrome")
  expect(t("touri Chrome", {}, "en")).toBe("touri Chrome")
  expect(
    t(
      "My Chrome is unavailable. In Google Chrome, open chrome://inspect/#remote-debugging, allow remote debugging and accept Chrome's permission prompt when the bot connects.",
      {},
      "en",
    ),
  ).toContain("accept Chrome's permission prompt")
})

it("saves the browser per bot and switches the browser with the execution machine", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const updateBot = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={bot}
      api={api}
      projects={[]}
      routines={[]}
      capability={{ available: true, reason: null, provider: null }}
      initialSection="computer"
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
      onOpenIntegrations={vi.fn()}
    />,
  )
  const browser = screen.getByRole("combobox", { name: "Navegador do bot" })
  fireEvent.change(browser, { target: { value: "local" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() => expect(updateBot).toHaveBeenCalledWith(bot.id, expect.objectContaining({ browser: "local" })))
  fireEvent.change(screen.getByRole("combobox", { name: "Máquina" }), { target: { value: "vm" } })
  expect(browser).toHaveValue("machine")
  expect(screen.getByRole("option", { name: "Meu Chrome" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenLastCalledWith(bot.id, expect.objectContaining({ machine: "vm", browser: "machine" })),
  )
})
