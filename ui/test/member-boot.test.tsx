import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ApiError } from "../src/errors"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

const ownerReads = ["GET /projects", "GET /settings", "GET /previews", "GET /routines"] as const

test("member boot finishes when owner-only workspace reads are forbidden", async () => {
  const mock = createMockApi()
  const bot = mock.getState().bots[0]
  if (!bot) throw new Error("Missing synthetic bot")
  const { group, thread } = await mock.request("POST /groups", {
    name: "Canal de teste",
    color: "#2e6a53",
    avatarShape: "circle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const request: ApiRequest = async (route, input, path) => {
    if (ownerReads.some((ownerRoute) => ownerRoute === route)) throw new ApiError(403, "Access denied", "FORBIDDEN")
    return mock.request(route, input, path)
  }
  const client = { ...mock, request, isMock: false }

  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  expect(hook.result.current.data.loaded).toBe(true)
  expect(hook.result.current.data.notice).toBeNull()
  expect(hook.result.current.data.bots.length).toBeGreaterThan(0)
  expect(hook.result.current.data.groups).toContainEqual(group)
  expect(hook.result.current.data.threads).toContainEqual(thread)
  expect(hook.result.current.data.projects).toEqual([])
  expect(hook.result.current.data.previews).toEqual([])
  expect(hook.result.current.data.routines).toEqual([])
  expect(hook.result.current.data.settings).toBeNull()
})

test.each(ownerReads)("a service failure in %s still prevents a successful snapshot", async (ownerRoute) => {
  const mock = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === ownerRoute) throw new ApiError(503, "Service unavailable", "SERVER_CONNECTION_FAILED")
    return mock.request(route, input, path)
  }
  const client = { ...mock, request, isMock: false }

  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  expect(hook.result.current.data.loaded).toBe(false)
  expect(hook.result.current.data.notice).not.toBeNull()
})

test.each(["GET /bots", "GET /workspace/activity", "GET /runs"] as const)(
  "a forbidden required read in %s still prevents a successful snapshot",
  async (requiredRoute) => {
    const mock = createMockApi()
    const request: ApiRequest = async (route, input, path) => {
      if (route === requiredRoute) throw new ApiError(403, "Access denied", "FORBIDDEN")
      return mock.request(route, input, path)
    }
    const client = { ...mock, request, isMock: false }

    const hook = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

    expect(hook.result.current.data.loaded).toBe(false)
    expect(hook.result.current.data.notice).not.toBeNull()
  },
)
