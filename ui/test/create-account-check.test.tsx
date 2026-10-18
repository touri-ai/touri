import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ProviderLoginFlow } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal } from "../src/components/Modals"
import { ApiError } from "../src/errors"
import { CREATE_PROVIDERS, useCreateProvider } from "../src/features/bots/useCreateProvider"

const ready = { provider: CREATE_PROVIDERS[0], state: "ready", executable: "available", host: "mac" } as const
afterEach(cleanup)

it("keeps discovery loading, then accepts the selected account despite an unrelated check failure", async () => {
  let settle: (flow: ProviderLoginFlow) => void = () => {}
  const selected = new Promise<ProviderLoginFlow>((resolve) => {
    settle = resolve
  })
  const api = createMockApi()
  api.request = vi.fn(async (route, input) => {
    if (route.startsWith("POST")) return ready
    if (input.provider !== ready.provider) throw new Error("unavailable account")
    return selected
  }) as ApiRequest
  const { result } = renderHook(() => useCreateProvider(api, "draft-check"))
  expect(result.current.checking).toBe(true)
  expect(result.current.error).toBeNull()
  await act(async () => {
    settle(ready)
  })
  await waitFor(() => expect(result.current.checking).toBe(false))
  expect(result.current.ready).toBe(true)
  expect(result.current.error).toBeNull()
})

it.each([new Error("failed check"), new DOMException("timed out", "TimeoutError")])(
  "reports a selected account failure only after its check settles: %s",
  async (error) => {
    let reject: (error: Error) => void = () => {}
    const selected = new Promise<ProviderLoginFlow>((_, fail) => {
      reject = fail
    })
    const api = createMockApi()
    api.request = vi.fn(async (route, input) => {
      if (route.startsWith("POST")) return ready
      return input.provider === ready.provider ? selected : { ...ready, provider: input.provider, state: "idle" }
    }) as ApiRequest
    const { result } = renderHook(() => useCreateProvider(api, "draft-check"))
    expect(result.current.error).toBeNull()
    expect(result.current.checking).toBe(true)
    await act(async () => {
      reject(error)
    })
    await waitFor(() => expect(result.current.checking).toBe(false))
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toBe("Não foi possível verificar as contas. Escolha uma conta e tente novamente.")
    api.request = vi.fn(async () => ready) as ApiRequest
    await act(async () => {
      await result.current.selectProvider(ready.provider)
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.error).toBeNull()
  },
)

it("keeps a retryable discovery failure in the loading state until recovery", async () => {
  const api = createMockApi()
  let attempts = 0
  api.request = vi.fn(async (route, input) => {
    if (route.startsWith("POST")) return ready
    if (input.provider !== ready.provider) return { ...ready, provider: input.provider, state: "idle" }
    if (++attempts === 1) throw new ApiError(504, "timed out", "TIMEOUT", "TOURI-E1008")
    return ready
  }) as ApiRequest
  const { result } = renderHook(() => useCreateProvider(api, "draft-check"))
  await waitFor(() => expect(attempts).toBe(1))
  expect(result.current.checking).toBe(true)
  expect(result.current.error).toBeNull()
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.error).toBeNull()
})

it("shows one settled error and offers a fresh check without a competing login loader", async () => {
  const api = createMockApi()
  const original = api.request
  let recovered = false
  api.request = vi.fn(async (route, input, path) => {
    if (route === "GET /bots/:id/provider-login/flow") {
      if (!recovered) throw new Error("account check failed")
      return ready
    }
    return original(route, input, path)
  }) as ApiRequest
  render(<BotCreateModal api={api} onClose={() => {}} onCreate={async () => {}} />)
  await screen.findByText("Não foi possível verificar as contas. Escolha uma conta e tente novamente.")
  expect(screen.queryByText("Verificando login…")).toBeNull()
  recovered = true
  fireEvent.click(screen.getByRole("button", { name: "Verificar novamente" }))
  await screen.findByText(/^Usa .*, conectado neste/)
  expect(screen.queryByRole("alert")).toBeNull()
})
