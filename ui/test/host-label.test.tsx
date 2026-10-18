import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { ApiRoutes, HostKind } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotDetails } from "../src/components/BotDetails"
import { routineHostNotice } from "../src/components/RoutineEditor"
import { getHostLabel, t } from "../src/i18n"
import { useHost } from "../src/useHost"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each(["computer", "server"] as const)("uses the %s sidecar host in a Mac browser", async (host) => {
  const api = getHostApi(host)
  setMacBrowser()

  const { result } = renderHook(() => useHost(api))

  await waitFor(() => expect(result.current).toBe(host))
  expect(navigator.platform).toBe("MacIntel")
  expect(getHostLabel(result.current)).toBe(host === "server" ? "servidor" : "computador")
})

it("uses a computer label while host information is unavailable", () => {
  setMacBrowser()

  const { result } = renderHook(() => useHost())

  expect(result.current).toBe("computer")
})

it("discards the previous host label while reconnecting to another sidecar", async () => {
  const api = getHostApi("mac")
  const nextApi = getHostApi("server")
  const { result, rerender } = renderHook(({ api }) => useHost(api), { initialProps: { api } })
  await waitFor(() => expect(result.current).toBe("mac"))

  rerender({ api: nextApi })

  expect(result.current).toBe("computer")
  await waitFor(() => expect(result.current).toBe("server"))
})

it.each(["mac", "computer", "server"] as const)("describes a local bot using its %s host", (host) => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Bot fixture unavailable")

  render(
    <BotDetails bot={{ ...bot, machine: "local" }} host={host} onSettings={vi.fn()} onPermissions={vi.fn()}>
      {null}
    </BotDetails>,
  )

  expect(screen.getByText(t("Works on this {host}.", { host: getHostLabel(host) }))).toBeVisible()
})

it("translates computer labels and routine availability in both languages", () => {
  const host = "computer"

  const portuguese = t("Works on this {host}.", { host: getHostLabel(host) })
  const english = t("Works on this {host}.", { host: getHostLabel(host, "en") }, "en")
  const routine = routineHostNotice(host)

  expect(portuguese).toBe("Trabalha neste computador.")
  expect(english).toBe("Works on this computer.")
  expect(routine).toBe("Funciona enquanto o touri estiver em execução neste computador.")
})

const getHostApi = (host: HostKind): UiApi => {
  const api = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /health")
      return { ok: true, version: "test", schemaVersion: 1, host } as ApiRoutes[typeof route]["res"]

    return api.request(route, input, path)
  }

  return { ...api, request }
}

const setMacBrowser = () => vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel")
