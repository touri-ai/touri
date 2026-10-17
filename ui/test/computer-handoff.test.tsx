import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { BotComputer } from "../src/components/BotComputer"
import { ComputerUseSettings } from "../src/features/computer/ComputerUseSettings"
import { t } from "../src/i18n"

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
const noDesktop =
  "Este servidor não tem uma área de trabalho para controlar. Você pode conversar e trabalhar com arquivos."

test("headless computer offers working chat/files actions and never requests native permissions or a desktop", () => {
  const request = vi.fn()
  const chat = vi.fn()
  const files = vi.fn()
  render(
    <BotComputer
      api={{ request } as unknown as UiApi}
      bot={{ id: "server", name: "Bot", machine: "local" } as Bot}
      onChat={chat}
      onFiles={files}
      onPermissions={vi.fn()}
    />,
  )
  expect(screen.getByText(noDesktop)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Conversar" }))
  fireEvent.click(screen.getByRole("button", { name: "Abrir arquivos" }))
  expect(chat).toHaveBeenCalledOnce()
  expect(files).toHaveBeenCalledOnce()
  expect(screen.queryByRole("button", { name: /controle|permiss|ligar|redefinir/i })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})

test("headless permission settings never poll or request native permissions", () => {
  vi.useFakeTimers()
  try {
    render(<ComputerUseSettings />)
    vi.advanceTimersByTime(60_000)
    expect(screen.getByText(noDesktop)).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test("handoff and recovery copy has matching English", () => {
  expect(t("Assumir controle", {}, "en")).toBe("Take control")
  expect(t("Devolver ao bot", {}, "en")).toBe("Return to bot")
  expect(t(noDesktop, {}, "en")).toContain("You can chat and work with files.")
})

test("an unavailable VM keeps its selected target and offers a retry without destructive reset", () => {
  const request = vi.fn(async () => ({}))
  render(
    <BotComputer
      api={{ request, subscribe: () => () => {} } as unknown as UiApi}
      bot={{ id: "vm", name: "Bot", machine: "vm" } as Bot}
      machine={{
        botId: "vm",
        status: "error",
        error: "Tela indisponível",
        progress: null,
        memoryMb: 1536,
        createdMs: 1,
        startMs: null,
      }}
    />,
  )
  expect(screen.getByRole("button", { name: "Ligar computador" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: /redefinir|apagar|mac|permiss/i })).not.toBeInTheDocument()
  expect(screen.queryByText(noDesktop)).not.toBeInTheDocument()
  expect(request.mock.calls.some(([route]) => route.startsWith("PATCH"))).toBe(false)
})

test("native desktop retains its permission controls", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  invoke.mockResolvedValue({ accessibility: "granted", "screen-recording": "granted" })
  render(<ComputerUseSettings />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("permissions_status"))
  expect(screen.getAllByRole("button", { name: t("Grant") })).toHaveLength(2)
  expect(screen.queryByText(noDesktop)).not.toBeInTheDocument()
})
