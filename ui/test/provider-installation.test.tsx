import { invoke } from "@tauri-apps/api/core"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderInstallation } from "../src/components/ProviderInstallation"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  vi.resetAllMocks()
})

it("opens installation instructions through the desktop external browser bridge", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  vi.mocked(invoke).mockResolvedValue(undefined)
  render(<ProviderInstallation provider="codex" host="mac" busy={false} onRecheck={vi.fn()} />)
  fireEvent.click(screen.getByRole("link", { name: "Ver como instalar" }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_external", {
      url: "https://developers.openai.com/codex/cli/",
    }),
  )
})

it("keeps a copyable installation link and explains an external-browser failure", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  vi.mocked(invoke).mockRejectedValue(new Error("unavailable"))
  render(<ProviderInstallation provider="claude" host="mac" busy={false} onRecheck={vi.fn()} />)
  const link = screen.getByRole("link", { name: "Ver como instalar" })
  fireEvent.click(link)
  expect(await screen.findByRole("alert")).toHaveTextContent("Copie o endereço do link")
  expect(link).toHaveAttribute("href", "https://code.claude.com/docs/en/setup")
})
