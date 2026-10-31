import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { ApiError } from "../src/errors"
import { useWorkspace } from "../src/useWorkspace"

afterEach(cleanup)

test("a paged branch keeps its position among chronological sibling keys", () => {
  const api = createMockApi()
  const template = api.getState().messages[0]
  if (!template) throw new Error("Missing synthetic message")
  const older: Message = { ...template, id: "older-branch", parentId: null, createdAt: 1 }
  const latest: Message = { ...template, id: "latest-branch", parentId: null, createdAt: 2 }
  const branchOptions = [older, latest].map(({ id, threadId, parentId, role, kind, createdAt }) => ({
    id,
    threadId,
    parentId,
    role,
    kind,
    createdAt,
  }))
  const onSwitchBranch = vi.fn()
  const view = render(
    <VirtualMessageList
      messages={[latest]}
      branchOptions={branchOptions}
      onSwitchBranch={onSwitchBranch}
      onRetry={async () => undefined}
    />,
  )

  const previous = view.getByRole("button", { name: "Ramificação anterior" })

  expect(previous).toBeEnabled()
  expect(view.getByRole("button", { name: "Próxima ramificação" })).toBeDisabled()
  fireEvent.click(previous)
  expect(onSwitchBranch.mock.calls[0]?.[1]?.[0]?.id).toBe(older.id)
  expect(onSwitchBranch.mock.calls[0]?.[2]).toBe(0)
})

test("equal-timestamp pages preserve server order even when transcript sequences differ", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Ordem fictícia",
    color: "#558866",
    avatarShape: "circle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  const messages = Array.from(
    { length: 80 },
    (_, index): Message => ({
      id: `ordered-${index}`,
      threadId: thread.id,
      parentId: index ? `ordered-${index - 1}` : null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: `Registro fictício ${index}`,
      parts: [],
      sender: null,
      source: "local",
      createdAt: 1,
      updatedAt: 1,
      seq: 80 - index,
    }),
  )
  api.getState().messages.push(...messages)
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))

  act(() => hook.result.current.actions.selectThread(thread.id))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe(thread.id))

  expect(hook.result.current.data.messages.map((message) => message.id)).toEqual(
    messages.slice(40).map((message) => message.id),
  )
  await act(() => hook.result.current.actions.loadOlderMessages())
  expect(hook.result.current.data.messages.map((message) => message.id)).toEqual(messages.map((message) => message.id))
})

test("returning to cached messages retries a failed run snapshot", async () => {
  const api = createMockApi()
  const reads: string[] = []
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /threads/:id/runs" && path?.id === "thread-mark") {
      reads.push(path.id)
      if (reads.length === 1) throw new ApiError(502, "Synthetic run snapshot failure")
    }
    return api.request(route, input, path, transport)
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-mark"))
  await waitFor(() => expect(hook.result.current.data.notice).toContain("Synthetic run snapshot failure"))
  const message = hook.result.current.data.messages[0]
  if (!message) throw new Error("Missing synthetic message")
  act(() =>
    api.emit({
      type: "message.updated",
      message: { ...message, text: "Registro fictício atualizado", updatedAt: message.updatedAt + 1 },
    }),
  )

  act(() => hook.result.current.actions.selectThread("thread-onb"))
  await waitFor(() => expect(hook.result.current.data.historyThreadId).toBe("thread-onb"))
  act(() => hook.result.current.actions.selectThread("thread-mark"))

  await waitFor(() => expect(reads).toHaveLength(2))
  expect(hook.result.current.data.messages.some((message) => message.threadId === "thread-mark")).toBe(true)
  await waitFor(() => expect(hook.result.current.data.notice).toBeNull())
})

test.each(["GET /groups", "GET /groups/:id/threads"])(
  "a failed %s refresh preserves the conversation and recovers in place",
  async (failedRoute) => {
    const api = createMockApi()
    const { group, thread } = await api.request("POST /groups", {
      name: "Canal exemplo",
      color: "#558866",
      memberIds: ["bot-mark"],
    })
    await api.request(
      "POST /threads/:id/messages",
      { text: "Mensagem preservada.", parentId: null, attachmentIds: [] },
      { id: thread.id },
    )
    let failing = false
    const request: ApiRequest = async (route, input, path, transport) => {
      if (failing && route === failedRoute) throw new ApiError(503, "Synthetic restart", "RUNTIME_DRAINING")
      return api.request(route, input, path, transport)
    }
    const client = { ...api, request }
    const hook = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(hook.result.current.data.loaded).toBe(true))
    act(() => hook.result.current.actions.selectThread(thread.id))
    await waitFor(() =>
      expect(hook.result.current.data.messages.some((message) => message.text === "Mensagem preservada.")).toBe(true),
    )

    failing = true
    await act(() => hook.result.current.actions.refresh())

    expect(hook.result.current.data.channelFailures?.[group.id]).toMatchObject({ kind: "restarting" })
    expect(hook.result.current.data.notice).toBeNull()
    expect(hook.result.current.data.messages.some((message) => message.text === "Mensagem preservada.")).toBe(true)
    expect(hook.result.current.data.threads.some((item) => item.id === thread.id)).toBe(true)
    failing = false
    await act(() => hook.result.current.actions.refresh())
    await waitFor(() => expect(hook.result.current.data.channelFailures?.[group.id]).toBeUndefined())
  },
)
