import { invoke } from "@tauri-apps/api/core"
import { afterEach, expect, test, vi } from "vitest"
import { createTauriInvoke } from "../src/api/client"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

test("server secrets go through the authenticated relay rather than the client vault", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  vi.mocked(invoke).mockResolvedValueOnce({ mode: "server", url: "https://server.example" }).mockResolvedValueOnce({
    baseUrl: "http://127.0.0.1:43123",
    wsUrl: "ws://127.0.0.1:43123/events",
    token: "relay-only",
  })
  const fetchImpl = vi.fn(async () => Response.json({}))
  vi.stubGlobal("fetch", fetchImpl)
  await expect(createTauriInvoke()("secret_save", { account: "project/test", value: "secret-value" })).resolves.toEqual(
    {},
  )
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(["server_mode_status", "sidecar_endpoint"])
  expect(fetchImpl).toHaveBeenCalledWith(
    "http://127.0.0.1:43123/api/v1/host/secret",
    expect.objectContaining({
      method: "POST",
      headers: { Authorization: "Bearer relay-only", "Content-Type": "application/json" },
      body: JSON.stringify({ account: "project/test", value: "secret-value" }),
    }),
  )
})

test("local secrets keep the native vault and failed mode resolution never falls back", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  vi.mocked(invoke).mockResolvedValueOnce({ mode: "local", url: null }).mockResolvedValueOnce({})
  const save = createTauriInvoke()
  await save("secret_save", { account: "project/test", value: "secret-value" })
  expect(invoke).toHaveBeenLastCalledWith("secret_save", { account: "project/test", value: "secret-value" })
  vi.mocked(invoke).mockReset().mockRejectedValueOnce(new Error("SERVER_STATE_UNAVAILABLE"))
  await expect(save("secret_save", { account: "project/test", value: "secret-value" })).rejects.toThrow(
    "SERVER_STATE_UNAVAILABLE",
  )
  expect(invoke).toHaveBeenCalledTimes(1)
})
