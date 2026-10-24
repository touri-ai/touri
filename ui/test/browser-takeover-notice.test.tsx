import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { BrowserTabInfo } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import { createMockApi } from "../src/api/mock"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

const getPersonTakeoverNotice = () => ({
  type: "notify" as const,
  level: "info" as const,
  title: "Browser takeover",
  body: "The user took over the browser: The user requested browser takeover",
  threadId: "thread-mark",
})

test("a person takeover echo stays quiet while browser state and history remain available", async () => {
  const api = createMockApi()
  const notification = api.notify({
    kind: "takeover",
    title: "Browser takeover",
    body: "needs you in the browser: login",
    botId: "bot-mark",
    threadId: "thread-mark",
    requestId: "browser-help",
  })
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.messages.length).toBeGreaterThan(0))
  const messages = hook.result.current.data.messages
  const tab: BrowserTabInfo & { ownerBotId: string } = {
    tabId: "browser-tab",
    ownerBotId: "bot-mark",
    url: "",
    title: "",
    state: "live",
    openerTabId: null,
    heldByUser: true,
    takeoverReason: "requested",
    lastUsedAt: 1,
  }

  act(() => {
    api.emit({ type: "browser.tab", tab })
    api.emit(getPersonTakeoverNotice())
  })

  expect(hook.result.current.data.notice).toBeNull()
  expect(hook.result.current.data.browserTabs).toContainEqual(tab)
  expect(hook.result.current.data.messages).toEqual(messages)
  expect(hook.result.current.data.notifications).toContainEqual(notification)
})

test("a person takeover echo preserves an existing notice", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => api.emit({ type: "notify", level: "info", title: "Status", body: "Synthetic status", threadId: null }))
  const notice = hook.result.current.data.notice

  act(() => api.emit(getPersonTakeoverNotice()))

  expect(notice).toBe("Status: Synthetic status")
  expect(hook.result.current.data.notice).toBe(notice)
})

test("a bot-requested browser intervention still surfaces its localized notice", async () => {
  const api = createMockApi()
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  act(() =>
    api.emit({
      type: "notify",
      level: "info",
      title: "Browser takeover",
      body: "needs you in the browser: login",
      threadId: "thread-mark",
    }),
  )

  expect(hook.result.current.data.notice).toBe("Controle do navegador: O navegador precisa da sua ajuda.")
})
