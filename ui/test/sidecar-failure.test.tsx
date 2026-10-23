import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { type ApiRequest, createApiClient, type TauriInvoke, type UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { makeConnectionEvents } from "./connection-events"

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
const localInvoke = (handler: (command: string, args: unknown) => Promise<unknown>) =>
  vi.fn(async (command: string, args: unknown) => {
    if (command === "server_mode_status") return { mode: "local", url: null }
    if (command === "deep_link_pending") return null
    if (command === "deep_link_ack") return {}
    return handler(command, args)
  })

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  const mock = createMockApi()
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /health"
      ? ({ ok: true, version: "0.3.0", schemaVersion: 6 } as ApiRoutes[typeof route]["res"])
      : mock.request(route, input, path)
  vi.mocked(createApiClient).mockReturnValue({ ...mock, request, isMock: false })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  shell.listeners.clear()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

describe("sidecar failure blocking state", () => {
  it("explains a startup protocol mismatch once and makes updating the primary action", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "server_mode_status") return { mode: "server", url: "https://touri.example" }
      if (command === "sidecar_endpoint") throw new Error("SERVER_VERSION_MISMATCH")
      return null
    })

    render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)

    const update = await screen.findByRole("button", { name: "Atualizar agora" })
    expect(update).toHaveClass("button-brand")
    expect(
      screen.getAllByText("Esta versão do aplicativo precisa de uma atualização para conversar com o servidor."),
    ).toHaveLength(1)
    expect(screen.queryByText("Servidor offline. Tentando reconectar…")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Tentar novamente/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reportar este problema" })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalledWith("updater_install", {})
  })

  it.each(["endpoint", "health"])("offers recovery when the first %s request never settles", async (stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const unavailableInvoke = vi.fn(() => new Promise(() => undefined))
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke: unavailableInvoke } })
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const api = vi.mocked(createApiClient)({ endpoint })
    const request = api.request
    api.request = (async (...args) => {
      if (stage === "health" && args[0] === "GET /health") await pending
      return request(...args)
    }) as ApiRequest
    let available = false
    const invoke = localInvoke(async (command: string) => {
      if (command === "sidecar_endpoint" && stage === "endpoint" && !available) await pending
      return endpoint
    })
    await act(async () => render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />))
    expect(screen.getByText("Preparando o espaço de trabalho…")).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    const alert = screen.getByRole("alert")
    expect(within(alert).getByRole("button", { name: /Tentar novamente/ })).toBeEnabled()
    expect(within(alert).getByRole("button", { name: "Reportar este problema" })).toBeEnabled()
    expect(
      within(alert).getByText("O serviço local demorou para responder. Tente conectar novamente.", { selector: "p" }),
    ).toBeVisible()
    // Reporting must open without waiting for the same unavailable service.
    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: "Reportar este problema" })))
    const report = screen.getByRole("dialog", { name: "Reportar problema" })
    expect(report).toBeVisible()
    expect(unavailableInvoke).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: "Escape" })
    await act(async () => finish?.())
    expect(alert).toBeVisible()
    available = true
    await act(async () => fireEvent.click(within(alert).getByRole("button", { name: /Tentar novamente/ })))
    expect(invoke).toHaveBeenCalledWith("sidecar_restart", {})
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it.each(["endpoint", "health"])(
    "retries server startup after the %s deadline and ignores the late response",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let finish: (() => void) | undefined
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const api = vi.mocked(createApiClient)({ endpoint })
      const request = api.request
      let healthChecks = 0
      const requestWithStall: ApiRequest = async (...args) => {
        if (args[0] === "GET /health" && ++healthChecks === 1 && stage === "health") await pending
        return request(...args)
      }

      vi.mocked(createApiClient).mockReturnValue({ ...api, request: requestWithStall })
      let endpointChecks = 0
      const invoke = vi.fn(async (command: string) => {
        if (command === "server_mode_status") return { mode: "server", url: "https://touri.example" }
        if (command === "sidecar_endpoint") {
          if (++endpointChecks === 1 && stage === "endpoint") await pending
          return endpoint
        }
        return null
      })
      await act(async () => {
        render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
      })

      expect(endpointChecks).toBe(1)
      expect(healthChecks).toBe(stage === "health" ? 1 : 0)

      await act(async () => vi.advanceTimersByTimeAsync(20_000))

      expect(screen.getByText("Servidor offline. Tentando reconectar…")).toBeVisible()

      await act(async () => finish?.())

      expect(screen.getByText("Servidor offline. Tentando reconectar…")).toBeVisible()
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument()

      await act(async () => vi.advanceTimersByTimeAsync(2000))

      expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      expect(screen.queryByText("Servidor offline. Tentando reconectar…")).not.toBeInTheDocument()
      expect(invoke.mock.calls.filter(([command]) => command === "sidecar_endpoint")).toHaveLength(2)
      expect(invoke).not.toHaveBeenCalledWith("sidecar_restart", {})
    },
  )

  it.each(["endpoint", "health"])(
    "gives a stalled %s retry a fresh deadline after a startup rejection",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let finish: (() => void) | undefined
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const api = vi.mocked(createApiClient)({ endpoint })
      const request = api.request
      let healthChecks = 0
      const requestWithStall: ApiRequest = async (...args) => {
        if (args[0] === "GET /health" && stage === "health") {
          healthChecks += 1
          if (healthChecks === 1) throw new Error("SERVER_OFFLINE")
          if (healthChecks === 2) await pending
        }
        return request(...args)
      }

      vi.mocked(createApiClient).mockReturnValue({ ...api, request: requestWithStall })
      let endpointChecks = 0
      const invoke = vi.fn(async (command: string) => {
        if (command === "server_mode_status") return { mode: "server", url: "https://touri.example" }
        if (command === "sidecar_endpoint") {
          endpointChecks += 1
          if (stage === "endpoint" && endpointChecks === 1) throw new Error("SERVER_OFFLINE")
          if (stage === "endpoint" && endpointChecks === 2) await pending
          return endpoint
        }
        return null
      })
      await act(async () => {
        render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
      })

      expect(endpointChecks).toBe(1)

      await act(async () => vi.advanceTimersByTimeAsync(2000))

      expect(endpointChecks).toBe(2)

      await act(async () => vi.advanceTimersByTimeAsync(20_000))

      expect(screen.getByText("Servidor offline. Tentando reconectar…")).toBeVisible()

      await act(async () => vi.advanceTimersByTimeAsync(2000))

      expect(endpointChecks).toBe(3)
      expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

      await act(async () => finish?.())

      expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()
      expect(invoke).not.toHaveBeenCalledWith("sidecar_restart", {})
    },
  )

  it("cancels a scheduled server retry when a readiness event restores the connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const api = vi.mocked(createApiClient)({ endpoint })
    const request = api.request
    let healthChecks = 0
    const requestWithStall: ApiRequest = async (...args) => {
      if (args[0] === "GET /health" && ++healthChecks === 1) await new Promise(() => undefined)
      return request(...args)
    }

    vi.mocked(createApiClient).mockReturnValue({ ...api, request: requestWithStall })
    const invoke = vi.fn(async (command: string) => {
      if (command === "server_mode_status") return { mode: "server", url: "https://touri.example" }
      if (command === "sidecar_endpoint") return endpoint
      return null
    })
    await act(async () => {
      render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    })
    await act(async () => vi.advanceTimersByTimeAsync(20_000))

    expect(screen.getByText("Servidor offline. Tentando reconectar…")).toBeVisible()

    await act(async () => shell.listeners.get("sidecar-ready")?.({ payload: endpoint }))

    expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBeVisible()

    await act(async () => vi.advanceTimersByTimeAsync(2000))

    expect(invoke.mock.calls.filter(([command]) => command === "sidecar_endpoint")).toHaveLength(2)
  })

  it("enables recovery again when the shell never acknowledges a restart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const invoke = localInvoke(async (command: string) => {
      if (command === "sidecar_restart") return new Promise(() => undefined)
      throw reason
    })
    await act(async () => render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />))
    const retry = screen.getByRole("button", { name: /Tentar novamente/ })
    await act(async () => fireEvent.click(retry))
    expect(retry).toBeDisabled()
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(retry).toBeEnabled()
    expect(
      screen.getByText("O serviço local demorou para responder. Tente conectar novamente.", { selector: "p" }),
    ).toBeVisible()
  })

  it("reads startup failures from the shell and cannot be dismissed", async () => {
    const invoke = localInvoke(async () => {
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
    expect(within(alert).getAllByRole("button")).toHaveLength(4)
    expect(within(alert).getByRole("button", { name: /Tentar novamente/ })).toBeVisible()
    expect(within(alert).getByRole("button", { name: "Reportar este problema" })).toBeVisible()
    expect(within(alert).getByRole("button", { name: "Usar um servidor touri" })).toBeVisible()
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
    const invoke = localInvoke(async (command: string) => {
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
        return { ok: true, version: "0.3.0", schemaVersion: 6 } as ApiRoutes[typeof route]["res"]
      }
      return api.request(route, input, path)
    }
    vi.mocked(createApiClient).mockReturnValue({ ...api, request, isMock: false })
    const invoke = localInvoke(async () => endpoint)
    render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    await waitFor(() => expect(finish).toBeDefined())
    act(() => shell.listeners.get("sidecar-failed")?.({ payload: reason }))
    await act(async () => finish?.())
    expect(screen.getByText(reason)).not.toBeVisible()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("keeps a restart command rejection visible", async () => {
    const invoke = localInvoke(async (command: string) => {
      throw command === "sidecar_restart" ? "sidecar supervisor is not ready" : reason
    })
    render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
    fireEvent.click(await screen.findByRole("button", { name: /Tentar novamente/ }))
    expect(await screen.findByText("sidecar supervisor is not ready")).not.toBeVisible()
    expect(screen.getByRole("button", { name: /Tentar novamente/ })).toBeEnabled()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("keeps the loaded conversation and draft mounted while a dropped backend reconnects", async () => {
    const connection = makeConnectionEvents()
    const api: UiApi = {
      ...createMockApi(),
      ...connection,
      isMock: false,
    }
    const invoke = localInvoke(async () => {
      throw reason
    })
    render(<App kernel={{ services: { api, invoke: invoke as TauriInvoke } }} />)
    const composer = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.change(composer, { target: { value: "Rascunho preservado" } })

    act(() => connection.emitConnection(false))

    expect(await screen.findByText("Reconectando…")).toBeVisible()
    expect(composer).toHaveValue("Rascunho preservado")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    act(() => connection.emitConnection(true))

    expect(screen.getByRole("textbox", { name: "Mensagem para mark" })).toBe(composer)
    expect(composer).toHaveValue("Rascunho preservado")
    expect(screen.queryByText("Reconectando…")).not.toBeInTheDocument()
  })
})
