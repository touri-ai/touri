import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Message } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApiError } from "../src/errors"
import { useCurrentPersonId } from "../src/useCurrentPersonId"

type Session = ApiRoutes["GET /session"]["res"]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const getMessage = (id: string, parentId: string | null, senderId: string, name: string): Message => ({
  id,
  parentId,
  threadId: "thread-mark",
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: `Mensagem de ${name}`,
  parts: [{ type: "text", text: `Mensagem de ${name}` }],
  sender: { id: senderId, name, avatarSeed: senderId, kind: "person" },
  source: "local",
  createdAt: 1,
  updatedAt: 1,
})

const getSessionApi = (getSession: () => Promise<Session>) => {
  const base = createMockApi()
  const connections = new Set<(connected: boolean) => void>()
  const messages = [
    getMessage("owner-message", null, "owner", "Pessoa A"),
    getMessage("member-message", "owner-message", "person-b", "Pessoa B"),
  ]
  const request: UiApi["request"] = async (route, input, path) => {
    if (route === "GET /session") return getSession() as Promise<ApiRoutes[typeof route]["res"]>
    if (route === "GET /threads/:id/messages")
      return { messages, activeLeafId: "member-message" } as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path)
  }
  const api: UiApi = {
    request,
    subscribe: base.subscribe,
    subscribeConnection: (listener) => {
      connections.add(listener)
      return () => connections.delete(listener)
    },
    isMock: false,
  }

  return {
    api,
    reconnect: () => {
      connections.forEach((listener) => {
        listener(true)
      })
    },
    getConnectionCount: () => connections.size,
  }
}

describe("session sender identity", () => {
  it.each(["reconnect", "online"])("recovers a member's identity after an initial failure and %s", async (recovery) => {
    const firstResponse = Promise.withResolvers<Session>()
    const getSession = vi
      .fn<() => Promise<Session>>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue({ person: { id: "person-b", name: "Pessoa B", avatarSeed: "person-b", role: "member" } })
    const { api, reconnect } = getSessionApi(getSession)
    render(<App kernel={{ services: { api } }} />)
    const ownMessage = (await screen.findByText("Mensagem de Pessoa B")).closest("article")
    const ownerMessage = screen.getByText("Mensagem de Pessoa A").closest("article")
    if (!ownMessage || !ownerMessage) throw new Error("Missing person messages")
    vi.useFakeTimers()
    await act(async () => {
      firstResponse.reject(new Error("Temporary session failure"))
    })
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      if (recovery === "online") fireEvent(window, new Event("online"))
      else reconnect()
    })

    expect(within(ownMessage).getByText("Você")).toBeVisible()
    expect(ownMessage).not.toHaveClass("message-other-person")
    expect(within(ownerMessage).getByText("Pessoa A")).toBeVisible()
    expect(ownerMessage).toHaveClass("message-other-person")
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it("shows sender names without claiming the owner's identity while the session is unresolved", async () => {
    const { api } = getSessionApi(() => new Promise<Session>(() => undefined))

    render(<App kernel={{ services: { api } }} />)

    const ownerMessage = (await screen.findByText("Mensagem de Pessoa A")).closest("article")
    if (!ownerMessage) throw new Error("Missing owner message")
    expect(within(ownerMessage).getByText("Pessoa A")).toBeVisible()
    expect(within(ownerMessage).queryByText("Você")).toBeNull()
  })

  it("retries transient failures without a connection event and stops after unmount", async () => {
    vi.useFakeTimers()
    const getSession = vi
      .fn<() => Promise<Session>>()
      .mockRejectedValueOnce(new Error("Temporary session failure"))
      .mockResolvedValue({ person: { id: "person-b", name: "Pessoa B", avatarSeed: "person-b", role: "member" } })
    const { api, getConnectionCount } = getSessionApi(getSession)
    const view = renderHook(() => useCurrentPersonId(api, false))
    await act(async () => undefined)
    expect(view.result.current).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(2000))

    expect(view.result.current).toBe("person-b")
    expect(getSession).toHaveBeenCalledTimes(2)
    view.unmount()
    fireEvent(window, new Event("online"))
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(getConnectionCount()).toBe(0)
  })

  it("coalesces recovery signals while a session read is pending", async () => {
    const response = Promise.withResolvers<Session>()
    const getSession = vi.fn(() => response.promise)
    const { api, reconnect } = getSessionApi(getSession)
    const view = renderHook(() => useCurrentPersonId(api, false))

    act(() => {
      reconnect()
      fireEvent(window, new Event("online"))
    })
    await act(async () => {
      response.resolve({ person: { id: "person-b", name: "Pessoa B", avatarSeed: "person-b", role: "member" } })
    })

    expect(getSession).toHaveBeenCalledTimes(1)
    expect(view.result.current).toBe("person-b")
  })

  it("ignores a previous connection's late identity response", async () => {
    const firstResponse = Promise.withResolvers<Session>()
    const first = getSessionApi(() => firstResponse.promise)
    const second = getSessionApi(async () => ({
      person: { id: "person-b", name: "Pessoa B", avatarSeed: "person-b", role: "member" },
    }))
    const view = renderHook(({ api }) => useCurrentPersonId(api, false), { initialProps: { api: first.api } })

    view.rerender({ api: second.api })
    await waitFor(() => expect(view.result.current).toBe("person-b"))
    await act(async () => {
      firstResponse.resolve({ person: { id: "owner", name: "Pessoa A", avatarSeed: "owner", role: "admin" } })
    })

    expect(view.result.current).toBe("person-b")
    expect(first.getConnectionCount()).toBe(0)
  })

  it("keeps local desktop messages outgoing without requesting a remote session", () => {
    const getSession = vi.fn<() => Promise<Session>>()
    const { api } = getSessionApi(getSession)

    const view = renderHook(() => useCurrentPersonId(api, true))

    expect(view.result.current).toBe("owner")
    expect(getSession).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404])("does not repeatedly request an unavailable session after HTTP %s", async (status) => {
    vi.useFakeTimers()
    const getSession = vi.fn<() => Promise<Session>>().mockRejectedValue(new ApiError(status, "Session unavailable"))
    const { api } = getSessionApi(getSession)
    const view = renderHook(() => useCurrentPersonId(api, false))

    await act(() => vi.advanceTimersByTimeAsync(60_000))

    expect(view.result.current).toBeNull()
    expect(getSession).toHaveBeenCalledTimes(1)
  })
})
