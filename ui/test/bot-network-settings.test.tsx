import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { BotNetworkSettings } from "../src/components/BotNetworkSettings"

afterEach(cleanup)
it("defaults LAN off, saves the selected permission and explains restart before loosening", async () => {
  const policy = { allowLan: false, resolvers: ["1.1.1.1", "8.8.8.8"], privateDomains: [] }
  const request = vi.fn(async (route: string, input: typeof policy) =>
    route.startsWith("PUT") ? { requested: input, active: policy } : { requested: policy, active: policy },
  )
  render(<BotNetworkSettings api={{ request } as unknown as UiApi} botId="bot" />)
  const toggle = screen.getByRole("switch", { name: "Permitir acesso à rede local" })
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(toggle).not.toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("PUT /bots/:id/network-policy", { ...policy, allowLan: true }, { id: "bot" }),
  )
  expect(await screen.findByRole("status")).toHaveTextContent("Reinicie a máquina")
  expect(toggle).toBeChecked()
})
it("tells users of machines created before the network policy how to regain LAN access", async () => {
  const policy = { allowLan: false, resolvers: ["1.1.1.1"], privateDomains: [] }
  const request = vi.fn(async () => ({ requested: policy, active: policy }))
  render(<BotNetworkSettings api={{ request } as unknown as UiApi} botId="bot" />)
  expect(screen.getByText(/criadas em versões anteriores também começam com a rede local bloqueada/)).toBeTruthy()
})
it("reports policy failures without claiming the permission was saved", async () => {
  const policy = { allowLan: false, resolvers: ["1.1.1.1"], privateDomains: [] }
  const request = vi.fn(async (route: string) => {
    if (route.startsWith("PUT")) throw new Error("failed")
    return { requested: policy, active: policy }
  })
  render(<BotNetworkSettings api={{ request } as unknown as UiApi} botId="bot" />)
  const toggle = screen.getByRole("switch", { name: "Permitir acesso à rede local" })
  await waitFor(() => expect(toggle).not.toBeDisabled())
  fireEvent.click(toggle)
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar")
  expect(toggle).not.toBeChecked()
})
it("#4 keeps the public allow-list off by default and saves the listed sites when enabled", async () => {
  const policy = { allowLan: false, resolvers: ["1.1.1.1"], privateDomains: [], restrictPublic: false, publicHosts: [] }
  const request = vi.fn(async (route: string, input: typeof policy) =>
    route.startsWith("PUT")
      ? { requested: input, active: { ...policy, ...input }, providerHosts: ["openai.com", "chatgpt.com"] }
      : { requested: policy, active: policy, providerHosts: ["openai.com", "chatgpt.com"] },
  )
  render(<BotNetworkSettings api={{ request } as unknown as UiApi} botId="bot" />)
  const toggle = screen.getByRole("switch", { name: "Limitar a internet a uma lista de sites" })
  await waitFor(() => expect(toggle).not.toBeDisabled())
  expect(toggle).not.toBeChecked()
  expect(screen.queryByLabelText(/Sites permitidos/)).toBeNull()
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "PUT /bots/:id/network-policy",
      { ...policy, restrictPublic: true, publicHosts: [] },
      { id: "bot" },
    ),
  )
  const list = await screen.findByLabelText(/Sites permitidos/)
  expect(screen.getByText(/Sempre liberados para o provedor deste bot: openai.com, chatgpt.com/)).toBeTruthy()
  fireEvent.change(list, { target: { value: "https://GitHub.com/org\nregistry.npmjs.org, github.com" } })
  fireEvent.blur(list)
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      "PUT /bots/:id/network-policy",
      { ...policy, restrictPublic: true, publicHosts: ["github.com", "registry.npmjs.org"] },
      { id: "bot" },
    ),
  )
})
it("#4 explains that loosening the allow-list waits for a restart", async () => {
  const active = { allowLan: false, resolvers: ["1.1.1.1"], privateDomains: [], restrictPublic: true, publicHosts: [] }
  const request = vi.fn(async () => ({
    requested: { ...active, publicHosts: ["github.com"] },
    active,
  }))
  render(<BotNetworkSettings api={{ request } as unknown as UiApi} botId="bot" />)
  expect(await screen.findByRole("status")).toHaveTextContent("Reinicie a máquina")
})
