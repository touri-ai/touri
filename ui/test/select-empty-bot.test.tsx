import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

const getApiWithEmptyBot = (failCreate = false) => {
  const api = createMockApi()
  const request = api.request
  const emptyBotId = { current: "" }
  const wrapped: ApiRequest = async (route, input, pathValues) => {
    if (route === "GET /bots/:id/threads" && pathValues?.id === emptyBotId.current) return { threads: [] } as never
    if (route === "POST /threads" && failCreate) throw new Error("offline")
    return request(route, input, pathValues)
  }
  return { api: { ...api, request: wrapped }, emptyBotId }
}

const renderWorkspace = async (failCreate = false) => {
  const { api, emptyBotId } = getApiWithEmptyBot(failCreate)
  const { bots } = await api.request("GET /bots", {})
  emptyBotId.current = bots[1]?.id ?? ""
  expect(emptyBotId.current).not.toBe("")
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  return { api, hook, botId: emptyBotId.current }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("creates a real thread when a bot without threads is selected", async () => {
  const { hook, botId } = await renderWorkspace()

  act(() => hook.result.current.actions.selectBot(botId))

  await waitFor(() => expect(hook.result.current.data.threadCreation).toBeNull())
  const { data } = hook.result.current
  expect(data.selectedBotId).toBe(botId)
  expect(data.selectedThreadId).not.toMatch(/^draft:/)
  expect(data.threads.some((thread) => thread.id === data.selectedThreadId && thread.botId === botId)).toBe(true)
})

it("marks the draft failed instead of pending forever when creation fails", async () => {
  const { hook, botId } = await renderWorkspace(true)

  act(() => hook.result.current.actions.selectBot(botId))

  await waitFor(() => expect(hook.result.current.data.threadCreation?.status).toBe("failed"))
  expect(hook.result.current.data.selectedThreadId).toBe(`draft:bot:${botId}`)
})
