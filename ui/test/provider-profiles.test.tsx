import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { ProviderProfileFields } from "../src/components/ProviderProfileFields"

afterEach(cleanup)

const profiles = [
  { name: "clav", provider: "claude", loggedIn: true, account: "ops@example.test" },
  { name: "lumx", provider: "claude", loggedIn: false, account: null },
  { name: "build", provider: "codex", loggedIn: true, account: null },
]

it("lists the provider's profiles with their accounts and reports the chosen one", async () => {
  const request = vi.fn(async () => ({ profiles }))
  const onChange = vi.fn()
  render(
    <ProviderProfileFields
      api={{ request } as unknown as UiApi}
      provider="claude"
      values={{ providerProfile: null, claudeAiConnectors: false }}
      onChange={onChange}
    />,
  )
  const select = screen.getByLabelText("Conta do provedor")
  await waitFor(() => expect(select).not.toBeDisabled())
  expect(request).toHaveBeenCalledWith("GET /provider-profiles", {})
  const labels = [...select.querySelectorAll("option")].map((option) => option.textContent)
  expect(labels).toEqual(["Login padrão deste computador", "clav (ops@example.test)", "lumx (sem login)"])
  fireEvent.change(select, { target: { value: "clav" } })
  expect(onChange).toHaveBeenCalledWith({ providerProfile: "clav" })
  fireEvent.click(screen.getByRole("switch", { name: /Conectores do claude.ai/ }))
  expect(onChange).toHaveBeenCalledWith({ claudeAiConnectors: true })
})

it("keeps a saved profile that disappeared visible and hides the connectors outside Claude", async () => {
  const request = vi.fn(async () => ({ profiles }))
  render(
    <ProviderProfileFields
      api={{ request } as unknown as UiApi}
      provider="codex"
      values={{ providerProfile: "gone", claudeAiConnectors: false }}
      onChange={() => {}}
    />,
  )
  const select = screen.getByLabelText("Conta do provedor")
  await waitFor(() => expect(select).not.toBeDisabled())
  expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
    "Login padrão deste computador",
    "build",
    "gone (não encontrada)",
  ])
  expect(screen.queryByRole("switch")).toBeNull()
})
