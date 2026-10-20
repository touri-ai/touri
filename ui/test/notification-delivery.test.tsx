import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { NotificationDeliverySettings } from "../src/components/NotificationDeliverySettings"
import { t } from "../src/i18n"

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }))
afterEach(() => {
  cleanup()
  host.invoke.mockReset()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})
const native = () => Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })

it("explains closed-app delivery on web in one hint without calling desktop APIs", () => {
  const { container } = render(<NotificationDeliverySettings enabled />)

  const hint = screen.getByText(
    "Com o touri fechado, você não recebe avisos. Ao abrir, as solicitações pendentes aparecem.",
  )

  expect(hint).toBeVisible()
  expect(hint).toHaveClass("field-help")
  expect(container.querySelectorAll("p")).toHaveLength(1)
  expect(host.invoke).not.toHaveBeenCalled()
  expect(screen.queryByRole("button")).toBeNull()
})
it("shows denied OS permission even when the saved preference is on, opens settings and tests explicitly", async () => {
  native()
  host.invoke.mockImplementation(async (command: string) =>
    command === "notification_open_settings" ? null : "denied",
  )
  render(<NotificationDeliverySettings enabled />)
  expect(await screen.findByText("Os avisos do sistema estão desativados.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Abrir ajustes" }))
  expect(host.invoke).toHaveBeenCalledWith("notification_open_settings")
  fireEvent.click(screen.getByRole("button", { name: "Testar aviso" }))
  await waitFor(() =>
    expect(host.invoke).toHaveBeenCalledWith(
      "notification_test",
      expect.objectContaining({ title: "Aviso de teste do touri" }),
    ),
  )
  expect(screen.queryByText("Teste enviado. Confira se o aviso apareceu no sistema.")).toBeNull()
})
it("rechecks OS changes on focus and asks the user to verify actual test delivery", async () => {
  native()
  host.invoke.mockResolvedValue("denied")
  render(<NotificationDeliverySettings enabled />)
  await screen.findByText("Os avisos do sistema estão desativados.")
  host.invoke.mockResolvedValue("granted")
  act(() => window.dispatchEvent(new Event("focus")))
  await screen.findByText("O sistema permite avisos. Teste a entrega.")
  fireEvent.click(screen.getByRole("button", { name: "Testar aviso" }))
  await screen.findByText("Teste enviado. Confira se o aviso apareceu no sistema.")
})
it("never claims delivery when OS authorization cannot be checked", async () => {
  native()
  host.invoke.mockRejectedValue(new Error("offline"))
  render(<NotificationDeliverySettings enabled />)
  await screen.findByText("Não foi possível verificar a autorização do sistema. Teste a entrega.")
  fireEvent.click(screen.getByRole("button", { name: "Testar aviso" }))
  await screen.findByRole("alert")
  expect(screen.queryByText("Teste enviado. Confira se o aviso apareceu no sistema.")).toBeNull()
})
it("provides matching English copy", () => {
  expect(t("Você tem {n} solicitações pendentes.", { n: 2 }, "en")).toBe("You have 2 pending requests.")
  expect(t("Os avisos do sistema estão desativados.", {}, "en")).toBe("System notifications are disabled.")
  expect(
    t("Com o touri fechado, você não recebe avisos. Ao abrir, as solicitações pendentes aparecem.", {}, "en"),
  ).toBe("With touri closed, you get no notifications. When you open it, pending requests appear.")
  expect(t("{bot} pede sua aprovação: {summary}", { bot: "Team", summary: "Write files" }, "en")).toBe(
    "Team asks for your approval: Write files",
  )
})
