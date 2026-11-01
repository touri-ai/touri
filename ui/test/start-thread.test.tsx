import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message, Thread } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { StartThreadAction } from "../src/components/StartThreadAction"

afterEach(cleanup)
const message: Message = {
  id: "message-plan",
  threadId: "channel-main",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Planejar lançamento",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
}

test.each(["user", "assistant"] as const)("message action starts an anchored thread for %s", async (role) => {
  const api = createMockApi()
  const request = vi.spyOn(api, "request").mockResolvedValue({ thread: { id: "thread-plan" } })
  const onSelect = vi.fn()
  render(<StartThreadAction message={{ ...message, role }} api={api} onSelect={onSelect} />)

  fireEvent.click(screen.getByRole("button", { name: "Iniciar thread" }))

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("thread-plan"))
  expect(request).toHaveBeenCalledWith(
    "POST /threads/:id/start-thread",
    { messageId: message.id },
    { id: message.threadId },
    { signal: expect.any(AbortSignal) },
  )
})

test.each([1, 3])("reply counter with %s replies opens the existing thread", (count) => {
  const api = createMockApi()
  const request = vi.spyOn(api, "request")
  const onSelect = vi.fn()
  const thread = { id: "thread-plan", replyCount: count } as Thread
  render(<StartThreadAction message={message} api={api} thread={thread} onSelect={onSelect} />)

  fireEvent.click(screen.getByRole("button", { name: count === 1 ? "1 resposta" : "3 respostas" }))

  expect(onSelect).toHaveBeenCalledWith(thread.id)
  expect(request).not.toHaveBeenCalled()
})

test("failed creation keeps the message action available and explains recovery", async () => {
  const api = createMockApi()
  vi.spyOn(api, "request").mockRejectedValue(new Error("offline"))
  render(<StartThreadAction message={message} api={api} onSelect={vi.fn()} />)

  fireEvent.click(screen.getByRole("button", { name: "Iniciar thread" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível iniciar a thread")
  expect(screen.getByRole("button", { name: "Iniciar thread" })).toBeEnabled()
})

test("an archived child leaves the message action available to restore it", () => {
  const api = createMockApi()
  const base = api.getState().threads[0]
  if (!base) throw new Error("Missing synthetic thread")
  const archived = { ...base, anchorMessageId: message.id, archivedAt: 1, replyCount: 3 }
  render(
    <VirtualMessageList
      messages={[message]}
      anchoredThreads={[archived]}
      api={api}
      onSelectThread={vi.fn()}
      onSwitchBranch={vi.fn()}
      onRetry={vi.fn()}
    />,
  )

  expect(screen.getByRole("button", { name: "Iniciar thread" })).toBeEnabled()
  expect(screen.queryByRole("button", { name: "3 respostas" })).toBeNull()
})

test("reply counter restores an archived anchored thread before selecting it", async () => {
  const api = createMockApi()
  const thread = { id: "thread-plan", replyCount: 3, archivedAt: 1 } as Thread
  const request = vi.spyOn(api, "request").mockResolvedValue({ thread: { ...thread, archivedAt: null } })
  const onSelect = vi.fn()
  render(<StartThreadAction message={message} api={api} thread={thread} onSelect={onSelect} />)

  fireEvent.click(screen.getByRole("button", { name: "3 respostas" }))

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(thread.id))
  expect(request).toHaveBeenCalledWith(
    "POST /threads/:id/start-thread",
    { messageId: message.id },
    { id: message.threadId },
    { signal: expect.any(AbortSignal) },
  )
})

test("leaving the message cancels a pending open and ignores its late response", async () => {
  const api = createMockApi()
  const pending = Promise.withResolvers<{ thread: { id: string } }>()
  const request = vi.spyOn(api, "request").mockReturnValue(pending.promise)
  const onSelect = vi.fn()
  const view = render(<StartThreadAction message={message} api={api} onSelect={onSelect} />)
  fireEvent.click(screen.getByRole("button", { name: "Iniciar thread" }))
  const signal = request.mock.calls[0]?.[3]?.signal

  view.unmount()
  await act(async () => pending.resolve({ thread: { id: "late-thread" } }))

  expect(signal?.aborted).toBe(true)
  expect(onSelect).not.toHaveBeenCalled()
})

test("a creation event before the HTTP response keeps the pending action mounted", async () => {
  const api = createMockApi()
  const base = api.getState().threads[0]
  if (!base) throw new Error("Missing synthetic thread")
  const thread = { ...base, id: "created-thread", anchorMessageId: message.id, replyCount: 0 }
  const pending = Promise.withResolvers<{ thread: Thread }>()
  const request = vi.spyOn(api, "request").mockReturnValue(pending.promise)
  const onSelect = vi.fn()
  const getList = (threads: Thread[]) => (
    <VirtualMessageList
      messages={[message]}
      anchoredThreads={threads}
      api={api}
      onSelectThread={onSelect}
      onSwitchBranch={vi.fn()}
      onRetry={vi.fn()}
    />
  )
  const view = render(getList([]))
  fireEvent.click(screen.getByRole("button", { name: "Iniciar thread" }))

  view.rerender(getList([thread]))
  await act(async () => pending.resolve({ thread }))

  expect(request.mock.calls[0]?.[3]?.signal?.aborted).toBe(false)
  expect(onSelect).toHaveBeenCalledWith(thread.id)
})
