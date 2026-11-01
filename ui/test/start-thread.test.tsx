import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message, Thread } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
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
  )
})

test("reply counter opens the existing thread without creating another", () => {
  const api = createMockApi()
  const request = vi.spyOn(api, "request")
  const onSelect = vi.fn()
  const thread = { id: "thread-plan", replyCount: 3 } as Thread
  render(<StartThreadAction message={message} api={api} thread={thread} onSelect={onSelect} />)

  fireEvent.click(screen.getByRole("button", { name: "3 respostas" }))

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
