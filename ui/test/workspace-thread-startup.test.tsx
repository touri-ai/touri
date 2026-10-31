import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

test("bot conversation indexes start before secondary workspace reads finish", async () => {
  const api = createMockApi()
  const machines = Promise.withResolvers<void>()
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /machines") await machines.promise

    return api.request(route, input, path, transport)
  }
  const client = Object.assign({}, api, { request })
  const hook = renderHook(() => useWorkspace(client))

  await waitFor(() => {
    const indexes = api.calls.filter((call) => call.route === "GET /bots/:id/threads")

    expect(indexes).toHaveLength(api.getState().bots.length)
  })

  expect(hook.result.current.data.botsLoaded).toBe(true)
  expect(hook.result.current.data.loaded).toBe(false)
  await act(async () => machines.resolve())
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
  expect(hook.result.current.data.threads.length).toBeGreaterThan(0)
})
