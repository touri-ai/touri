import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ChannelReadState, Message, Run, Thread, UiEvent, UiEventEnvelope } from "@touri/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { useChannelReads } from "../src/useChannelReads"

const channel = { id: "avisos-thread", groupId: "avisos", groupThreadId: null, archivedAt: null } as Thread

/** A server holding one channel's unread replies; reading it clears them. */
const getServer = (unread: number) => {
  const state = { unread, reads: 0 }
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  const connections = new Set<(connected: boolean) => void>()
  const read = () => ({ threadId: channel.id, readAt: 2, unread: state.unread, mentions: 0 })
  const request = vi.fn(async (route: string) => {
    if (route === "GET /channel-reads") return { channels: [read()] }
    state.reads += 1
    state.unread = 0
    return { channel: read() }
  })
  const api = {
    request,
    subscribeConnection: (listener: (connected: boolean) => void) => {
      connections.add(listener)
      return () => connections.delete(listener)
    },
    subscribe: (listener: (envelope: UiEventEnvelope) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as UiApi
  const reply = () => {
    state.unread += 1
    const message = { threadId: channel.id, role: "assistant", status: "complete" } as Message
    listeners.forEach((listener) => {
      listener({ seq: 1, event: { type: "message.updated", message } } as UiEventEnvelope)
    })
  }

  const finish = () => {
    state.unread += 1
    const run = { threadId: channel.id, status: "succeeded" } as Run
    listeners.forEach((listener) => {
      listener({ seq: 2, event: { type: "run.updated", run } })
    })
  }

  const publish = (event: UiEvent) =>
    listeners.forEach((listener) => {
      listener({ seq: 3, event })
    })
  const reconnect = () =>
    connections.forEach((listener) => {
      listener(true)
    })

  return { api, state, reply, request, finish, reconnect, publish }
}

let focused = true
beforeEach(() => {
  focused = true
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("reads the open channel when a reply settles while the person is looking at it", async () => {
  const server = getServer(0)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: channel.id, enabled: true }),
  )
  // Nothing is known before the first load, so nothing can look new.
  expect(result.current).toBeNull()
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))

  act(() => server.reply())

  await waitFor(() => expect(server.state.reads).toBe(1))
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))
})

it("leaves replies unread while the window is in the background, and reads them on return", async () => {
  focused = false
  const server = getServer(2)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: channel.id, enabled: true }),
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(2))
  expect(server.state.reads).toBe(0)

  focused = true
  act(() => {
    window.dispatchEvent(new Event("focus"))
  })

  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))
  expect(server.state.reads).toBe(1)
})

it("keeps another channel's replies unread and refreshes them as they settle", async () => {
  const server = getServer(0)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: "other-thread", enabled: true }),
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))

  act(() => server.reply())

  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
  expect(server.state.reads).toBe(0)
})

it("does not restore unread replies from a snapshot that arrived after the channel was read", async () => {
  const server = getServer(1)
  const { result, rerender } = renderHook(
    ({ openThreadId }: { openThreadId: string | null }) =>
      useChannelReads({ api: server.api, threads: [channel], openThreadId, enabled: true }),
    { initialProps: { openThreadId: null } },
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
  const pending = Promise.withResolvers<{ channels: ChannelReadState[] }>()
  server.request.mockImplementationOnce(() => pending.promise)

  act(() => server.reply())
  await waitFor(() => expect(server.request).toHaveBeenCalledTimes(2))
  rerender({ openThreadId: channel.id })
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))
  // Move away before the older snapshot arrives: it must not resurrect a badge.
  rerender({ openThreadId: null })
  await act(async () =>
    pending.resolve({
      channels: [{ threadId: channel.id, readAt: 1, unread: 2, mentions: 0 }],
    }),
  )

  expect(result.current?.get(channel.id)?.unread).toBe(0)
})

it("refreshes when the run succeeds after the complete message was already delivered", async () => {
  const server = getServer(0)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: "other-thread", enabled: true }),
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))

  act(() => server.finish())

  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
})

it("retries an interrupted read when the connection returns with the same unread count", async () => {
  const server = getServer(1)
  const { result, rerender } = renderHook(
    ({ openThreadId }: { openThreadId: string | null }) =>
      useChannelReads({ api: server.api, threads: [channel], openThreadId, enabled: true }),
    { initialProps: { openThreadId: null } },
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
  server.request.mockRejectedValueOnce(new Error("Connection interrupted"))
  rerender({ openThreadId: channel.id })
  await waitFor(() => expect(server.request).toHaveBeenCalledTimes(2))

  act(() => server.reconnect())

  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))
  expect(server.state.reads).toBe(1)
})

it("drops unread state after a channel is deleted", async () => {
  const server = getServer(1)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: null, enabled: true }),
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
  server.request.mockResolvedValueOnce({ channels: [] })

  act(() => server.publish({ type: "group.deleted", groupId: "avisos" }))

  await waitFor(() => expect(result.current?.size).toBe(0))
})

it("refreshes a new channel even when replies arrive before its thread metadata", async () => {
  const server = getServer(0)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [], openThreadId: null, enabled: true }),
  )
  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(0))

  act(() => {
    server.reply()
    server.publish({ type: "thread.updated", thread: channel })
  })

  await waitFor(() => expect(result.current?.get(channel.id)?.unread).toBe(1))
})
