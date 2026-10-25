import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

const getProcessFixture = async () => {
  const base = createMockApi()
  await base.request("PATCH /bots/:id", { machine: "vm" }, { id: "bot-onb" })
  const { processes: host } = await base.request("GET /projects/:id/processes", {}, { id: "project-demo" })
  const guest = host.map((entry) =>
    Object.assign({}, entry, {
      spec: Object.assign({}, entry.spec, { id: `vm-${entry.spec.id}`, vmBotId: "bot-onb" }),
    }),
  )
  const request: ApiRequest = async (route, input, path) => {
    if (route !== "GET /projects/:id/processes") return structuredClone(await base.request(route, input, path))

    const scope = input as ApiRoutes["GET /projects/:id/processes"]["req"]

    return { processes: scope.vmBotId ? guest : host } as ApiRoutes[typeof route]["res"]
  }
  const api: UiApi = Object.assign({}, base, { request, isMock: false })

  return { base, host, guest, api }
}

test("changing a selected bot's computer clears Preview controls before its request resolves", async () => {
  const fixture = await getProcessFixture()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /projects/:id/processes" && (input as { vmBotId?: string }).vmBotId) return new Promise(() => {})

    return fixture.api.request(route, input, path)
  }
  const api = Object.assign({}, fixture.api, { request })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.processes).toEqual(fixture.host))
  const selected = hook.result.current.data.bots.find((bot) => bot.id === hook.result.current.data.selectedBotId)
  if (!selected) throw new Error("Missing selected synthetic bot")

  act(() => fixture.base.emit({ type: "bot.updated", bot: Object.assign({}, selected, { machine: "vm" as const }) }))

  expect(hook.result.current.data.processes).toEqual([])
})

test("a process created on the previous computer cannot replace the selected computer's controls", async () => {
  const fixture = await getProcessFixture()
  const deferred = Promise.withResolvers<ApiRoutes["PUT /projects/:id/processes/:name"]["res"]>()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "PUT /projects/:id/processes/:name") return deferred.promise

    return fixture.api.request(route, input, path)
  }
  const api = Object.assign({}, fixture.api, { request })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.processes).toEqual(fixture.host))
  const spec = fixture.host[0]?.spec
  if (!spec) throw new Error("Missing synthetic process")
  const creation = hook.result.current.actions.createProcess("project-demo", "synthetic", spec)
  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() => expect(hook.result.current.data.processes).toEqual(fixture.guest))

  await act(async () => {
    deferred.resolve({ spec })
    await creation
  })

  expect(hook.result.current.data.selectedBotId).toBe("bot-onb")
  expect(hook.result.current.data.processes).toEqual(fixture.guest)
})

test("previews with the same URL stay scoped to their project and computer", async () => {
  const fixture = await getProcessFixture()
  const hook = renderHook(() => useWorkspace(fixture.api))
  await waitFor(() => expect(hook.result.current.data.processes).toEqual(fixture.host))
  const preview = {
    projectId: "project-demo",
    processId: null,
    url: "http://localhost:4300",
    port: 4300,
    label: "Synthetic preview",
  }
  const guest = Object.assign({}, preview, { vmBotId: "bot-onb" })
  const otherProject = Object.assign({}, preview, { projectId: "synthetic-other-project" })

  act(() => {
    fixture.base.emit({ type: "preview.available", preview })
    fixture.base.emit({ type: "preview.available", preview: guest })
    fixture.base.emit({ type: "preview.available", preview: otherProject })
  })

  expect(hook.result.current.data.previews).toContainEqual(preview)
  expect(hook.result.current.data.previews).toContainEqual(guest)
  expect(hook.result.current.data.previews).toContainEqual(otherProject)
})
