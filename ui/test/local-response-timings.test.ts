import type { Message, Run } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import { createResponseTimings } from "../src/localResponseTimings"

it("records the first ten conversations locally and separates acknowledgement, provider and useful text", () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value)
    }),
  }
  let clock = 0
  const timings = createResponseTimings(storage, () => clock)
  for (let i = 0; i < 11; i++) {
    clock = i * 10_000
    timings.begin(`t${i}`, `nonce${i}`)
    clock += 20
    const message = {
      id: `m${i}`,
      threadId: `t${i}`,
      role: "user",
      delivery: { clientNonce: `nonce${i}`, status: "acked" },
    } as Message
    timings.observe({ type: "message.updated", message })
    const run = { id: `r${i}`, threadId: `t${i}`, requestMessageId: message.id, status: "starting" } as Run
    timings.observe({ type: "run.updated", run })
    clock += 100
    timings.observe({ type: "run.updated", run: { ...run, providerStartedAt: clock } })
    clock += 4_810
    timings.observe({ type: "run.updated", run: { ...run, status: "running" } })
    timings.observe({
      type: "message.delta",
      threadId: `t${i}`,
      messageId: `a${i}`,
      partIndex: 0,
      delta: "private reasoning",
      partType: "reasoning",
    })
    clock += 50
    timings.observe({
      type: "message.delta",
      threadId: `t${i}`,
      messageId: `a${i}`,
      partIndex: 1,
      delta: "private answer",
      partType: "text",
    })
  }
  expect(timings.read()).toHaveLength(10)
  for (const row of timings.read())
    expect(row).toMatchObject({
      sendToAcceptMs: 20,
      acceptToFirstEventMs: 4_910,
      providerToFirstEventMs: 4_810,
      sendToFirstTextMs: 4_980,
    })
  expect(JSON.stringify([...data.values()])).not.toMatch(/private reasoning|private answer/)
  expect(createResponseTimings(storage, () => clock).read()).toEqual(timings.read())
  const writes = storage.setItem.mock.calls.length
  timings.observe({
    type: "message.delta",
    threadId: "t0",
    messageId: "a0",
    partIndex: 1,
    delta: "more text",
    partType: "text",
  })
  expect(storage.setItem.mock.calls).toHaveLength(writes)
  timings.begin("t0", "second-turn")
  expect(timings.read()).toHaveLength(10)
})

it("survives unavailable or corrupt local storage", () => {
  const timings = createResponseTimings({
    getItem: () => "invalid",
    setItem: () => {
      throw new Error("full")
    },
  })
  expect(() => timings.begin("thread", "nonce")).not.toThrow()
  expect(timings.read()).toHaveLength(1)
})

it("keeps event and useful text times when the provider answers before the send acknowledgement", () => {
  let clock = 0
  const storage = { getItem: () => null, setItem: vi.fn() }
  const timings = createResponseTimings(storage, () => clock)
  timings.begin("thread", "early")
  const request = {
    id: "request",
    threadId: "thread",
    role: "user",
    runId: null,
    text: "private prompt",
    parts: [],
    delivery: { clientNonce: "early", deadline: 1000, status: "queued" },
  } as Message
  timings.observe({ type: "message.created", message: request })
  const run = {
    id: "run",
    threadId: "thread",
    requestMessageId: "request",
    status: "starting",
    providerStartedAt: 12,
  } as Run
  clock = 12
  timings.observe({ type: "run.updated", run })
  clock = 50
  timings.observe({ type: "run.updated", run: { ...run, status: "running" } })
  clock = 60
  timings.observe({
    type: "message.updated",
    message: {
      id: "reply",
      threadId: "thread",
      role: "assistant",
      runId: run.id,
      text: "private answer",
      parts: [{ type: "text", text: "private answer" }],
    } as Message,
  })
  clock = 80
  timings.observe({
    type: "message.updated",
    message: { ...request, delivery: { clientNonce: "early", deadline: 1000, status: "acked" } },
  })
  expect(timings.read()).toEqual([
    {
      conversation: 1,
      sendToAcceptMs: 12,
      acceptToFirstEventMs: 38,
      sendToFirstTextMs: 60,
      providerToFirstEventMs: 38,
    },
  ])
  expect(JSON.stringify(storage.setItem.mock.calls)).not.toMatch(/private prompt|private answer/)
})
