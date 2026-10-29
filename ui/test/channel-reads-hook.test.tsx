import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { Message, Thread, UiEventEnvelope } from "@touri/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { useChannelReads } from "../src/useChannelReads"

const channel = { id: "avisos-thread", groupId: "avisos", groupThreadId: null, archivedAt: null } as Thread

/** A server holding one channel's unread replies; reading it clears them. */
const getServer = (unread: number) => {
  const state = { unread, reads: 0 }
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  const read = () => ({ threadId: channel.id, readAt: 2, unread: state.unread, mentions: 0 })
  const request = vi.fn(async (route: string) => {
    if (route === "GET /channel-reads") return { channels: [read()] }
    state.reads += 1
    state.unread = 0
    return { channel: read() }
  })
  const api = {
    request,
    subscribe: (listener: (envelope: UiEventEnvelope) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as UiApi
  const reply = () => {
    state.unread += 1
    const message = { threadId: channel.id, role: "assistant", status: "complete" } as Message
    listeners.forEach((listener) => {
      listener({ seq: 1, event: { type: "message.updated", message } } as UiEventEnvelope)
    })
  }

  return { api, state, reply }
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
  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(0))

  act(() => server.reply())

  await waitFor(() => expect(server.state.reads).toBe(1))
  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(0))
})

it("leaves replies unread while the window is in the background, and reads them on return", async () => {
  focused = false
  const server = getServer(2)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: channel.id, enabled: true }),
  )
  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(2))
  expect(server.state.reads).toBe(0)

  focused = true
  act(() => {
    window.dispatchEvent(new Event("focus"))
  })

  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(0))
  expect(server.state.reads).toBe(1)
})

it("keeps another channel's replies unread and refreshes them as they settle", async () => {
  const server = getServer(0)
  const { result } = renderHook(() =>
    useChannelReads({ api: server.api, threads: [channel], openThreadId: "other-thread", enabled: true }),
  )
  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(0))

  act(() => server.reply())

  await waitFor(() => expect(result.current.get(channel.id)?.unread).toBe(1))
  expect(server.state.reads).toBe(0)
})
