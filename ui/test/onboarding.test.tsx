import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { DiscoveredServer } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import {
  hasCompletedOnboarding,
  type OnboardingRequest,
  OnboardingUnsupportedError,
} from "../src/features/onboarding/client"
import { getServerUrl, Onboarding } from "../src/features/onboarding/Onboarding"
import { dictionaries } from "../src/i18n"
import { getGuideBotFixture } from "./fixtures/onboarding-guide"

afterEach(cleanup)

const getRequest = (overrides: Record<string, unknown> = {}): OnboardingRequest =>
  vi.fn(async (route) => {
    if (route in overrides) return overrides[route]
    if (route === "GET /onboarding")
      return { completed: false, hasData: false, tailscale: "unavailable", remoteUrl: null }
    if (route === "GET /onboarding/servers") return { servers: [], tailscale: "missing" }
    if (route === "POST /onboarding") return { completed: true, url: null }
    return { found: false }
  }) as OnboardingRequest
const getInvoke = (): TauriInvoke => vi.fn(async () => null) as TauriInvoke

it("starts with a location choice before creating a workspace", async () => {
  const request = getRequest()
  const complete = vi.fn()
  render(<Onboarding request={request} invoke={getInvoke()} onComplete={complete} />)

  fireEvent.click(screen.getByRole("button", { name: /^Começar/ }))

  expect(screen.getByRole("heading", { name: "Onde seus agentes vão morar?" })).toBeVisible()
  expect(complete).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalledWith("POST /onboarding", expect.anything())
})

it("skips a completed installation and recognizes existing browser state", async () => {
  const complete = vi.fn()
  render(
    <Onboarding
      request={getRequest({
        "GET /onboarding": { completed: true, hasData: true, tailscale: "ready", remoteUrl: null },
      })}
      invoke={getInvoke()}
      onComplete={complete}
    />,
  )

  await waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(hasCompletedOnboarding({ getItem: () => "{}" } as Storage)).toBe(true)
})

it("offers the two server paths and actionable missing-network help", async () => {
  render(<Onboarding request={getRequest()} invoke={getInvoke()} onComplete={vi.fn()} revisiting />)

  fireEvent.click(screen.getByRole("button", { name: /Usar meu servidor/ }))
  fireEvent.click(screen.getByRole("button", { name: /Este (Mac|PC)/ }))

  await screen.findByText(/Para ativar: instale o Tailscale/)
  expect(screen.getByRole("switch")).toBeDisabled()
  expect(screen.queryByText(/estatísticas anônimas/)).toBeNull()
  expect(screen.getByLabelText("Seu nome")).toBeRequired()
  expect(screen.getByRole("button", { name: "Verificar novamente" })).toBeEnabled()
})

it("shows discovered servers as probes finish, while a slower peer is pending", async () => {
  const local: DiscoveredServer = { name: "", url: "http://localhost:18841", source: "local" }
  const peer: DiscoveredServer = {
    name: "studio.example.ts.net",
    url: "https://studio.example.ts.net:8445",
    source: "tailnet",
  }
  const request = getRequest({ "GET /onboarding/servers": { servers: [local, peer], tailscale: "ready" } })
  const slowProbe = Promise.withResolvers<{ found: boolean }>()
  const original = request
  const delayed = vi.fn((route, input, signal) => {
    if (route === "POST /onboarding/probe")
      return input.url === local.url ? Promise.resolve({ found: true }) : slowProbe.promise
    return original(route, input, signal)
  }) as OnboardingRequest
  render(<Onboarding request={delayed} invoke={getInvoke()} onComplete={vi.fn()} initialStep="connect" />)

  await screen.findByRole("button", { name: "Usar Este computador" })

  expect(screen.queryByText(peer.name)).toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("Procurando")
  slowProbe.resolve({ found: true })
  await screen.findByText(peer.name)
})

it("uses existing pairing, clears rejected codes and leaves a recoverable error", async () => {
  const invoke = vi.fn(async () => {
    throw new Error("SERVER_CODE_INVALID")
  }) as TauriInvoke
  render(<Onboarding request={getRequest()} invoke={invoke} onComplete={vi.fn()} initialStep="connect" />)

  fireEvent.change(screen.getByLabelText("Endereço do servidor"), { target: { value: "studio.example.ts.net:8445" } })
  fireEvent.click(screen.getByRole("button", { name: "Conectar ao servidor" }))
  fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value: "FAKE-CODE" } })
  fireEvent.click(screen.getByRole("button", { name: "Parear e continuar" }))

  await screen.findByRole("alert")
  expect(invoke).toHaveBeenCalledWith("server_mode_pair", {
    url: "https://studio.example.ts.net:8445",
    code: "FAKE-CODE",
  })
  expect(screen.getByLabelText("Código de pareamento")).toHaveValue("")
  expect(screen.getByRole("alert")).toHaveTextContent("Gere outro código")
})

it.each([
  "http://remote.example",
  "https://name:secret@remote.example",
  "https://remote.example/?token=secret",
  "file:///etc/passwd",
])("rejects unsafe addresses: %s", (address) => {
  expect(() => getServerUrl(address)).toThrow()
})

it("translates every first-run string to English", () => {
  const keys = Object.keys(dictionaries["pt-BR"]).filter((key) => key.startsWith("setup."))

  expect(keys.length).toBeGreaterThan(40)
  keys.forEach((key) => {
    expect(dictionaries.en[key as keyof typeof dictionaries.en]).not.toBe(
      dictionaries["pt-BR"][key as keyof typeof dictionaries.en],
    )
  })
})

it("returns to the existing local runtime before configuring a computer from server mode", async () => {
  const invoke = vi.fn(async (command) =>
    command === "server_mode_status"
      ? { mode: "server", url: "https://studio.example.ts.net:8445" }
      : { mode: "local", url: null },
  ) as TauriInvoke
  const complete = vi.fn()
  render(<Onboarding request={getRequest()} invoke={invoke} onComplete={complete} initialStep="choose" revisiting />)

  fireEvent.click(screen.getByRole("button", { name: /Este (Mac|PC)/ }))

  await waitFor(() => expect(invoke).toHaveBeenCalledWith("server_mode_local", {}))
  expect(complete).toHaveBeenCalledOnce()
  localStorage.removeItem("touri.onboarding.resume.v1")
})

it("does not pair the desktop with the runtime that its restart would stop", async () => {
  const invoke = getInvoke()
  const request = getRequest({
    "GET /onboarding": {
      completed: false,
      hasData: false,
      tailscale: "missing",
      remoteUrl: null,
      runtimeUrl: "http://127.0.0.1:18840",
    },
  })
  render(<Onboarding request={request} invoke={invoke} onComplete={vi.fn()} initialStep="connect" />)
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull())

  fireEvent.change(screen.getByLabelText("Endereço do servidor"), { target: { value: "http://localhost:18840" } })
  fireEvent.click(screen.getByRole("button", { name: "Conectar ao servidor" }))
  fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value: "FAKE-CODE" } })
  fireEvent.click(screen.getByRole("button", { name: "Parear e continuar" }))

  await screen.findByRole("alert")
  expect(screen.getByRole("alert")).toHaveTextContent("já está rodando neste computador")
  expect(invoke).not.toHaveBeenCalled()
})

it("opens an already configured server after first pairing without restarting workspace setup", async () => {
  const status = vi
    .fn()
    .mockResolvedValueOnce({ completed: false, hasData: false, tailscale: "missing", remoteUrl: null })
    .mockResolvedValue({ completed: true, hasData: true, tailscale: "ready", remoteUrl: null })
  const fallback = getRequest()
  const request = vi.fn((route, input, signal) =>
    route === "GET /onboarding" ? status() : fallback(route, input, signal),
  ) as OnboardingRequest
  const invoke = vi.fn(async (command) =>
    command === "server_mode_pair" ? { mode: "server", url: "https://server.example.com" } : null,
  ) as TauriInvoke
  const complete = vi.fn()
  render(<Onboarding request={request} invoke={invoke} onComplete={complete} initialStep="connect" />)
  fireEvent.change(screen.getByLabelText("Endereço do servidor"), { target: { value: "https://server.example.com" } })
  fireEvent.click(screen.getByRole("button", { name: "Conectar ao servidor", exact: true }))
  fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value: "FAKE-CODE" } })

  fireEvent.click(screen.getByRole("button", { name: "Parear e continuar" }))

  await waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(status).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole("heading", { name: "Como chama seu espaço?" })).toBeNull()
})

it("opens an existing server that has bots but no optional onboarding route", async () => {
  const status = vi
    .fn()
    .mockResolvedValueOnce({ completed: false, hasData: false, tailscale: "missing", remoteUrl: null })
    .mockRejectedValue(new OnboardingUnsupportedError())
  const fallback = getRequest()
  const request = vi.fn((route, input, signal) => {
    if (route === "GET /onboarding") return status()
    if (route === "GET /bots") return Promise.resolve({ bots: [getGuideBotFixture()] })
    return fallback(route, input, signal)
  }) as OnboardingRequest
  const invoke = vi.fn(async (command) =>
    command === "server_mode_pair" ? { mode: "server", url: "https://server.example.com" } : null,
  ) as TauriInvoke
  const complete = vi.fn()
  render(<Onboarding request={request} invoke={invoke} onComplete={complete} initialStep="connect" />)
  fireEvent.change(screen.getByLabelText("Endereço do servidor"), { target: { value: "https://server.example.com" } })
  fireEvent.click(screen.getByRole("button", { name: "Conectar ao servidor", exact: true }))
  fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value: "FAKE-CODE" } })

  fireEvent.click(screen.getByRole("button", { name: "Parear e continuar" }))

  await waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(request).toHaveBeenCalledWith("GET /bots", {})
})
