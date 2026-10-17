import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { type ApiRequest, createApiClient, type TauriInvoke, type UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

const shell = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    shell.listeners.set(name, handler)
    return () => {
      shell.listeners.delete(name)
    }
  }),
}))

vi.mock("../src/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/client")>()),
  createApiClient: vi.fn(),
}))

const endpoint = { baseUrl: "http://127.0.0.1:43123", wsUrl: "ws://127.0.0.1:43123/api/v1/events", token: "test" }
const reason = "schema mismatch: shell expects 6, sidecar reported 5"

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  const mock = createMockApi()
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /health"
      ? ({ ok: true, version: "0.2.0", schemaVersion: 6 } as ApiRoutes[typeof route]["res"])
      : mock.request(route, input, path)
  vi.mocked(createApiClient).mockReturnValue({ ...mock, request, isMock: false })
})

afterEach(() => {
  vi.restoreAllMocks()
  shell.listeners.clear()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

describe("sidecar failure blocking state", () => {
  it("reads startup failures from the shell and cannot be dismissed", async () => {
    const invoke = vi.fn(async () => {
      throw reason
    })
    render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    const alert = await screen.findByRole("alert")
    expect(invoke).toHaveBeenCalledWith("sidecar_endpoint", {})
    expect(
      within(alert).getByRole("heading", { name: "Não foi possível conectar aos serviços do touri." }),
    ).toBeVisible()
    expect(within(alert).getByText(reason)).not.toBeVisible()
    expect(within(alert).getByText("O aplicativo e o serviço local usam versões incompatíveis.")).toBeVisible()
    expect(within(alert).getAllByRole("button")).toHaveLength(2)
    expect(within(alert).getByRole("button", { name: /Tentar novamente/ })).toBeVisible()
    expect(within(alert).getByRole("button", { name: "Reportar este problema" })).toBeVisible()
    fireEvent.keyDown(window, { key: "Escape" })
    fireEvent.click(screen.getByRole("main"))
    expect(alert).toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(createApiClient).not.toHaveBeenCalled()
    fireEvent.click(within(alert).getByText("Detalhes do erro"))
    expect(within(alert).getByText(reason)).toBeVisible()
  })

  it("blocks a loaded workspace on sidecar-failed and asks the shell to restart before recovering", async () => {
    let restart: (() => void) | undefined
    let available = true
    const invoke = vi.fn(async (command: string) => {
      if (command === "sidecar_restart") {
        await new Promise<void>((resolve) => {
          restart = resolve
        })
        return {}
      }
      if (command === "sidecar_endpoint" && !available) throw reason
      return endpoint
    })
    const view = render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    available = false
    act(() => shell.listeners.get("sidecar-failed")?.({ payload: reason }))
    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText(reason)).not.toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    fireEvent.click(within(alert).getByRole("button", { name: /Tentar novamente/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sidecar_restart", {}))
    expect(alert).toBeVisible()
    expect(within(alert).getByRole("button", { name: /Tentar novamente/ })).toBeDisabled()
    await act(async () => restart?.())
    await waitFor(() => expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeEnabled())
    expect(screen.getByText(reason)).not.toBeVisible()
    available = true
    act(() => shell.listeners.get("sidecar-ready")?.({ payload: endpoint }))
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    view.unmount()
    expect(shell.listeners.size).toBe(0)
  })

  it("keeps the failure visible when an older health request completes after sidecar-failed", async () => {
    let finish: (() => void) | undefined
    const api = createMockApi()
    const request: ApiRequest = async (route, input, path) => {
      if (route === "GET /health") {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { ok: true, version: "0.2.0", schemaVersion: 6 } as ApiRoutes[typeof route]["res"]
      }
      return api.request(route, input, path)
    }
    vi.mocked(createApiClient).mockReturnValue({ ...api, request, isMock: false })
    render(<App kernel={{ services: { invoke: (async () => endpoint) as TauriInvoke } }} />)
    await waitFor(() => expect(finish).toBeDefined())
    act(() => shell.listeners.get("sidecar-failed")?.({ payload: reason }))
    await act(async () => finish?.())
    expect(screen.getByText(reason)).not.toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("keeps a restart command rejection visible", async () => {
    const invoke = vi.fn(async (command: string) => {
      throw command === "sidecar_restart" ? "sidecar supervisor is not ready" : reason
    })
    render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    fireEvent.click(await screen.findByRole("button", { name: /Tentar novamente/ }))
    expect(await screen.findByText("sidecar supervisor is not ready")).not.toBeVisible()
    expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeEnabled()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("blocks on a dropped backend connection even when conversations are already loaded", async () => {
    let connection: ((connected: boolean) => void) | undefined
    const api: UiApi = {
      ...createMockApi(),
      isMock: false,
      subscribeConnection: (listener) => {
        connection = listener
        return () => {
          connection = undefined
        }
      },
    }
    const invoke = vi.fn(async () => {
      throw reason
    })
    render(<App kernel={{ services: { api, invoke: invoke as TauriInvoke } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() => connection?.(false))
    expect(await screen.findByText(reason)).not.toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    act(() => connection?.(true))
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
