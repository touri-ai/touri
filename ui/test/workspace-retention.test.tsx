import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { pendingApprovalTargets } from "../src/approvalNavigation"
import { computeBotActivity } from "../src/botActivity"
import { useWorkspace } from "../src/useWorkspace"
import { retainWorkspace } from "../src/workspaceRetention"
import { createRetentionWorkload, retainedStateBudget, retentionBotCount } from "./fixtures/retentionWorkload"

afterEach(cleanup)

const deferred = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("open conversation tokens preserve unchanged background messages and runs", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  await act(async () => workload.round())
  const message = { ...workload.message(0, 1), status: "streaming" as const, updatedSeq: 100 }
  act(() => {
    workload.api.emit({ type: "run.updated", run: { ...workload.run(0, 1), status: "running", finishedAt: null } })
    workload.api.emit({ type: "message.created", message })
  })
  const before = hook.result.current.data
  const background = before.activityMessages.filter((row) => row.threadId !== message.threadId)

  Array.from({ length: 20 }).forEach((_, index) => {
    act(() =>
      workload.api.emit({
        type: "message.delta",
        threadId: message.threadId,
        messageId: message.id,
        partIndex: 2,
        offset: message.text.length + index,
        delta: ".",
        updatedSeq: index + 101,
      }),
    )
    const after = hook.result.current.data
    const unchanged = after.activityMessages.filter((row) => row.threadId !== message.threadId)

    unchanged.forEach((row, index) => {
      expect(row).toBe(background[index])
    })
    expect(after.runs).toBe(before.runs)
  })
  expect(hook.result.current.data.messages.find((row) => row.id === message.id)?.text).toBe(
    message.text + ".".repeat(20),
  )
})

test("a late acknowledgement cannot restore a closed conversation when only messages change", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  const before = hook.result.current.data
  const late = workload.message(1, 1)
  const arrived = { ...before, messages: [...before.messages, late] }

  const retained = retainWorkspace(arrived, before)

  expect(retained.messages).toEqual(before.messages)
  expect(retained.activityMessages.find((row) => row.id === late.id)?.text).toBe(late.text.slice(0, 512))
  expect(retained.activityMessages.find((row) => row.id === late.id)?.parts).toEqual([])
  expect(retained.runs).toBe(before.runs)
  expect(late.parts).toHaveLength(3)
})

test("open run updates do not read background ordering or rebuild retained collections", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  const getQueuedAt = vi.fn(() => 1)
  const background = [1, 2].map((turn) => ({
    ...workload.run(1, turn),
    status: "running" as const,
    get queuedAt() {
      return getQueuedAt()
    },
  }))
  const openRun = { ...workload.run(0, 1), status: "running" as const }
  const before = { ...hook.result.current.data, runs: [openRun, ...background] }
  const arrived = { ...before, runs: [{ ...openRun, externalTurnId: "stream-progress" }, ...background] }

  const retained = retainWorkspace(arrived, before)

  expect(getQueuedAt).not.toHaveBeenCalled()
  expect(retained).toBe(arrived)
  expect(retained.activityMessages).toBe(before.activityMessages)
  expect(retained.runs).toBe(arrived.runs)
})

test("retaining an already bounded workspace preserves collection identity", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  await act(async () => workload.round())
  const before = hook.result.current.data

  const retained = retainWorkspace(before)

  expect(retained).toBe(before)
  expect(retained.activityMessages).toBe(before.activityMessages)
  expect(retained.runs).toBe(before.runs)
})

test("30 bots stay within a 1 MiB retained-state budget across background waves and visited histories", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  for (let wave = 0; wave < 2; wave++) {
    // Separate acts model separate event deliveries, avoiding an artificially large React update queue.
    for (let round = 0; round < 20; round++) await act(async () => workload.round())
    const data = hook.result.current.data
    expect(data.messages.every((message) => message.threadId === "retention-thread-0")).toBe(true)
    expect(data.activityMessages.length).toBeLessThanOrEqual(retentionBotCount * 5)
    expect(data.runs.every((run) => data.bots.some((bot) => bot.id === run.botId))).toBe(true)
    expect(data.runs).toHaveLength(retentionBotCount)
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThan(retainedStateBudget)
    expect(workload.historyRequests.slice(1).every((count) => count === 0)).toBe(true)
    const activity = computeBotActivity({
      ...data,
      messages: data.activityMessages,
      attention: [],
      lastViewed: {},
      viewingBotId: data.selectedBotId,
    })
    expect(activity.get("retention-bot-1")?.kind).toBe("new")
  }
  for (let bot = 1; bot < retentionBotCount; bot++) {
    act(() => hook.result.current.actions.selectBot(`retention-bot-${bot}`))
    await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(41))
    expect(hook.result.current.data.messages.every((message) => message.threadId === `retention-thread-${bot}`)).toBe(
      true,
    )
  }
  act(() => hook.result.current.actions.selectBot("retention-bot-0"))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  expect(workload.historyRequests[0]).toBe(2)
  expect(hook.result.current.data.runs).toHaveLength(retentionBotCount)
  expect(new TextEncoder().encode(JSON.stringify(hook.result.current.data)).byteLength).toBeLessThan(
    retainedStateBudget,
  )
  // Opening again restores every generated failed/canceled turn and its full tool result.
  act(() => hook.result.current.actions.selectBot("retention-bot-1"))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(41))
  expect(workload.historyRequests[1]).toBe(2)
  expect(hook.result.current.data.messages).toEqual(Array.from({ length: 41 }, (_, turn) => workload.message(1, turn)))
})

test("leaving an in-flight history discards its late result and reopening requests a fresh snapshot", async () => {
  const workload = createRetentionWorkload()
  const barrier = deferred()
  let delayed = true
  const request: ApiRequest = async (route, input, path) => {
    const snapshot = await workload.api.request(route, input, path)
    if (route === "GET /threads/:id/messages" && path?.id === "retention-thread-1" && delayed) await barrier.promise
    return snapshot
  }
  const client = { ...workload.api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  act(() => hook.result.current.actions.selectBot("retention-bot-1"))
  await waitFor(() => expect(workload.historyRequests[1]).toBe(1))
  act(() => hook.result.current.actions.selectBot("retention-bot-0"))
  await waitFor(() => expect(workload.historyRequests[0]).toBe(2))
  await act(async () => {
    barrier.resolve()
    await barrier.promise
  })
  expect(hook.result.current.data.messages.map((message) => message.threadId)).toEqual(["retention-thread-0"])
  delayed = false
  act(() => hook.result.current.actions.selectBot("retention-bot-1"))
  await waitFor(() => expect(workload.historyRequests[1]).toBe(2))
  await waitFor(() => expect(hook.result.current.data.messages[0]?.threadId).toBe("retention-thread-1"))
})

test("offscreen approval patches survive newer turns and cannot be revived after resolution", async () => {
  const workload = createRetentionWorkload()
  const hook = renderHook(() => useWorkspace(workload.api))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  const message: Message = {
    ...workload.message(1, 0),
    id: "waiting-request",
    status: "streaming",
    text: "",
    parts: [],
    updatedSeq: 1,
  }
  const approval = {
    type: "approval" as const,
    approvalId: "background-approval",
    request: "command" as const,
    detail: "pwd",
    decision: "pending" as const,
  }
  act(() => {
    workload.api.emit({ type: "message.created", message })
    workload.api.emit({
      type: "message.parts",
      threadId: message.threadId,
      messageId: message.id,
      updatedSeq: 2,
      parts: [{ partIndex: 40, part: approval }],
    })
  })
  for (let round = 0; round < 4; round++) await act(async () => workload.round())
  expect(hook.result.current.data.messages.some((row) => row.id === message.id)).toBe(false)
  expect(pendingApprovalTargets(hook.result.current.data.activityMessages)).toContainEqual({
    threadId: message.threadId,
    approvalId: approval.approvalId,
  })
  act(() => {
    const note = workload.api.notify({
      kind: "approval",
      title: "Approve action",
      body: "pwd",
      botId: "retention-bot-1",
      threadId: message.threadId,
      requestId: approval.approvalId,
    })
    workload.api.emit({
      type: "notification.resolved",
      notification: { ...note, resolvedAt: 10, resolution: "allow" },
    })
  })
  act(() =>
    workload.api.emit({
      type: "message.parts",
      threadId: message.threadId,
      messageId: message.id,
      updatedSeq: 3,
      parts: [{ partIndex: 40, part: approval }],
    }),
  )
  expect(pendingApprovalTargets(hook.result.current.data.activityMessages)).toEqual([])
})

test("active streams reload on open and retain snapshot overlap and reasoning parts", async () => {
  const workload = createRetentionWorkload()
  const barrier = deferred()
  let delayed = false
  const snapshot = {
    ...workload.message(1, 0),
    status: "streaming" as const,
    text: "Oi",
    parts: [{ type: "text" as const, text: "Oi" }],
    updatedSeq: 1,
  }
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages" && path?.id === snapshot.threadId) {
      if (delayed) await barrier.promise
      return { messages: [structuredClone(snapshot)] } as never
    }
    return workload.api.request(route, input, path)
  }
  const client = { ...workload.api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.messages).toHaveLength(1))
  act(() => {
    workload.api.emit({ type: "run.updated", run: { ...workload.run(1, 1), status: "running", finishedAt: null } })
    workload.api.emit({ type: "message.created", message: snapshot })
  })
  expect(hook.result.current.data.runs.some((run) => run.botId === "retention-bot-1" && run.status === "running")).toBe(
    true,
  )
  delayed = true
  act(() => hook.result.current.actions.selectBot("retention-bot-1"))
  await act(async () => {
    workload.api.emit({
      type: "message.delta",
      threadId: snapshot.threadId,
      messageId: snapshot.id,
      partIndex: 0,
      offset: 2,
      delta: " mundo",
      updatedSeq: 2,
    })
    workload.api.emit({
      type: "message.parts",
      threadId: snapshot.threadId,
      messageId: snapshot.id,
      updatedSeq: 3,
      parts: [{ partIndex: 1, part: { type: "reasoning", text: "Generated reasoning" } }],
    })
    barrier.resolve()
  })
  await waitFor(() => expect(hook.result.current.data.messages[0]?.text).toBe("Oi mundo"))
  expect(hook.result.current.data.messages[0]?.parts[1]).toEqual({ type: "reasoning", text: "Generated reasoning" })
})

test("group history reloads with sender identity while private member transcripts stay offscreen", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Generated team",
    color: "#888888",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const template = api.getState().messages[0]
  if (!template) throw new Error("Missing group template")
  const reply = {
    ...template,
    id: "group-member-reply",
    threadId: thread.id,
    role: "assistant" as const,
    sender: { id: "bot-onb", name: "onb" },
  }
  // The mock API exposes its own mutable server fixture to seed history for this test.
  api.getState().messages.push(reply)
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => {
    api.emit({ type: "thread.updated", thread: { ...thread, id: "private-member-thread", groupThreadId: thread.id } })
    api.emit({ type: "message.created", message: { ...reply, id: "private-reply", threadId: "private-member-thread" } })
    hook.result.current.actions.selectThread(thread.id)
  })
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((row) => row.id === reply.id)?.sender).toEqual(reply.sender),
  )
  act(() => hook.result.current.actions.selectBot("bot-mark"))
  await waitFor(() => expect(hook.result.current.data.messages.every((row) => row.threadId !== thread.id)).toBe(true))
  expect(hook.result.current.data.activityMessages.some((row) => row.id === "private-reply")).toBe(false)
  act(() => hook.result.current.actions.selectThread(thread.id))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((row) => row.id === reply.id)?.sender).toEqual(reply.sender),
  )
  expect(
    api.calls.filter((call) => call.route === "GET /threads/:id/messages" && call.pathValues.id === thread.id),
  ).toHaveLength(2)
})

test("opening an evicted conversation restores the full pending send from the durable client journal", async () => {
  const api = createMockApi()
  const template = api.getState().messages[0]
  if (!template) throw new Error("Missing pending-send template")
  const text = "Generated pending request. ".repeat(100)
  const pending: Message = {
    ...template,
    id: "send:retention-pending",
    threadId: "thread-onb",
    role: "user",
    text,
    parts: [{ type: "text", text }],
    delivery: { clientNonce: "retention-pending", deadline: Date.now() + 60_000, status: "queued" },
  }
  const client = { ...api, pendingMessages: () => [pending] }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(hook.result.current.data.messages.some((row) => row.id === pending.id)).toBe(false)
  act(() => hook.result.current.actions.selectBot("bot-onb"))
  await waitFor(() => expect(hook.result.current.data.messages.find((row) => row.id === pending.id)?.text).toBe(text))
  expect(hook.result.current.data.messages.find((row) => row.id === pending.id)?.delivery?.status).toBe("queued")
  expect(api.calls.some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
})

test("a history request overflowing its stream buffer reloads instead of retaining the event backlog", async () => {
  const api = createMockApi()
  const stored = api.getState().messages.find((message) => message.role === "assistant")
  if (!stored) throw new Error("Missing streaming template")
  // Seed the fresh mock's server-owned message before delivering the overlapping stream.
  Object.assign(stored, { status: "streaming", text: "", parts: [{ type: "text", text: "" }], updatedSeq: 1 })
  const barrier = deferred()
  let reads = 0
  const request: ApiRequest = async (route, input, path) => {
    const response = structuredClone(await api.request(route, input, path))
    if (route === "GET /threads/:id/messages" && path?.id === stored.threadId && ++reads === 1) await barrier.promise
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(reads).toBe(1))
  const delta = "Generated stream. ".repeat(256)
  await act(async () => {
    for (let index = 0; index < 40; index++)
      api.emit({
        type: "message.delta",
        threadId: stored.threadId,
        messageId: stored.id,
        partIndex: 0,
        offset: index * delta.length,
        delta,
        updatedSeq: index + 2,
      })
    stored.text = delta.repeat(40)
    stored.parts = [{ type: "text", text: stored.text }]
    stored.updatedSeq = 41
    barrier.resolve()
  })
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() =>
    expect(hook.result.current.data.messages.find((message) => message.id === stored.id)?.text).toBe(stored.text),
  )
})
