import type { ToolCallPart } from "@touri/contracts"
import { expect, test } from "vitest"
import { getBrowserContinuationActivities } from "../src/components/browserContinuationActivity"

const getTool = (tool: string): ToolCallPart => ({
  type: "tool_call",
  callId: "call-1",
  tool,
  inputJson: '{"tabId":"tab-login"}',
  outputJson: null,
  summary: "Browser action",
  ok: true,
})

test("a browser continuation keeps one original card and every turn's actions", () => {
  const messages = [
    { id: "original", role: "assistant" as const, runId: "run-1", parts: [getTool("browser_request_takeover")] },
    { id: "answer", role: "assistant" as const, runId: "run-2", parts: [getTool("browser_snapshot")] },
  ]
  const runs = [
    { id: "run-2", status: "running" as const, queuedAt: 2, browserTakeoverFromRunId: "run-1" },
    { id: "run-1", status: "succeeded" as const, queuedAt: 1, browserTakeoverFromRunId: null },
  ]

  const { activities, hidden } = getBrowserContinuationActivities(messages, runs)

  expect(activities.size).toBe(1)
  expect(activities.get("original")).toMatchObject({ runId: "run-2", finished: false })
  expect(activities.get("original")?.parts.map((part) => part.callId)).toEqual(["run-1:call-1", "run-2:call-1"])
  expect(hidden).toEqual(new Set(["answer"]))
})

test("a queued handback keeps the card live before the next message exists", () => {
  const messages = [
    { id: "original", role: "assistant" as const, runId: "run-1", parts: [getTool("browser_request_takeover")] },
  ]
  const runs = [{ id: "run-2", status: "queued" as const, queuedAt: 2, browserTakeoverFromRunId: "run-1" }]

  const { activities, hidden } = getBrowserContinuationActivities(messages, runs)

  expect(activities.get("original")).toMatchObject({ runId: "run-2", finished: false })
  expect(hidden.size).toBe(0)
})

test("missing original messages keep the continuation's own browser card visible", () => {
  const messages = [{ id: "answer", role: "assistant" as const, runId: "run-2", parts: [getTool("browser_snapshot")] }]
  const runs = [{ id: "run-2", status: "succeeded" as const, queuedAt: 2, browserTakeoverFromRunId: "run-1" }]

  const { activities, hidden } = getBrowserContinuationActivities(messages, runs)

  expect(activities.size).toBe(0)
  expect(hidden.size).toBe(0)
})
