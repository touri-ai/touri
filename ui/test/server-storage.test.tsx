import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { TauriInvoke, UiApi } from "../src/api/client"
import { useComposerDraft } from "../src/composerDraft"
import { installComputerKillSwitch } from "../src/computerKillSwitch"
import { setStorageScope } from "../src/storageScope"
import { readWorkspaceState, saveWorkspaceState } from "../src/workspaceState"

afterEach(() => {
  cleanup()
  setStorageScope(null)
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

test("the server-mode emergency shortcut targets the remote API without calling the local host", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true })
  setStorageScope("https://server.example")
  const request = vi.fn(async () => ({}))
  const invoke = vi.fn()
  const error = vi.fn()
  const stop = installComputerKillSwitch({ request } as unknown as UiApi, invoke as TauriInvoke, error)
  try {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ".",
        code: "Period",
        ctrlKey: true,
        altKey: true,
        metaKey: true,
      }),
    )
    await Promise.resolve()
    expect(request).toHaveBeenCalledWith("POST /computer/kill", {})
    expect(invoke).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})

test("workspace selections remain attached to the selected server and preserve existing local data", () => {
  setStorageScope(null)
  saveWorkspaceState({ botId: "local-bot", threadId: "same-thread" })
  setStorageScope("https://server.example")
  expect(readWorkspaceState()).toEqual({})
  saveWorkspaceState({ botId: "remote-bot", threadId: "same-thread" })
  setStorageScope("https://another.example")
  expect(readWorkspaceState()).toEqual({})
  setStorageScope("https://server.example/")
  expect(readWorkspaceState().botId).toBe("remote-bot")
  setStorageScope(null)
  expect(readWorkspaceState().botId).toBe("local-bot")
})

test("drafts and a late send callback cannot cross server boundaries even when thread IDs match", () => {
  setStorageScope(null)
  const { result, rerender } = renderHook(() => useComposerDraft("same-thread"))
  act(() => result.current.setDraft("local draft"))
  const clearOldDraft = result.current.setDraft
  setStorageScope("https://server.example")
  rerender()
  expect(result.current.draft).toBe("")
  act(() => result.current.setDraft("server draft"))
  act(() => clearOldDraft(""))
  expect(result.current.draft).toBe("server draft")
  setStorageScope("https://another.example")
  rerender()
  expect(result.current.draft).toBe("")
  setStorageScope("https://server.example")
  rerender()
  expect(result.current.draft).toBe("server draft")
  setStorageScope(null)
  rerender()
  expect(result.current.draft).toBe("")
})
