import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import { ConnectionNotice } from "../src/features/server/ConnectionNotice"
import { t } from "../src/i18n"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("a temporary outage only shows a quiet reconnection status", () => {
  const invoke = vi.fn<TauriInvoke>(async () => null)

  render(<ConnectionNotice invoke={invoke} />)

  expect(screen.getByRole("status")).toHaveTextContent("Reconectando…")
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  expect(invoke).not.toHaveBeenCalled()
  expect(t("Reconectando…", {}, "en")).toBe("Reconnecting…")
})

test("an incompatible protocol only installs an update after an explicit click", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const invoke = vi.fn<TauriInvoke>(async () => null)
  render(<ConnectionNotice incompatible invoke={invoke} />)
  expect(invoke).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }))

  await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith("updater_install", {}))
})

test("a failed update keeps the conversation open and offers a retry", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  const invoke = vi.fn<TauriInvoke>(async () => {
    throw new Error("Update failed")
  })
  render(<ConnectionNotice incompatible invoke={invoke} />)

  fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }))

  expect(await screen.findByText("Não foi possível atualizar. Tente novamente.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Atualizar agora" })).toBeEnabled()
})
