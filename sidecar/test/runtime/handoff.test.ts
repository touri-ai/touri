import { afterEach, expect, spyOn, test } from "bun:test"
import type { Message, Thread } from "@touri/contracts"
import { buildHandoffPacket } from "../../src/runtime/handoff"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()

afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

test("empty history does not slice the recent messages", async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await initStore(fixture.kernel)

  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store API")
  const emptyHistory: Message[] = []
  const guardedHistory = new Proxy(emptyHistory, {
    get: (target, property, receiver) => {
      if (property === "slice") throw new Error("Empty history cannot be sliced")
      return Reflect.get(target, property, receiver)
    },
  })
  spyOn(store, "activePath").mockImplementation(({ fromRoot }) => (fromRoot ? [] : guardedHistory))

  const packet = buildHandoffPacket({ kernel: fixture.kernel, thread: getThread(), reason: "session replaced" })

  expect(packet).toContain("Recent messages:\n\nOlder excerpts:")
})

const getThread = (): Thread => ({
  id: "thread",
  botId: "bot",
  parentThreadId: null,
  kind: "main",
  title: "Conversa",
  activeLeafId: null,
  routineRunId: null,
  cwdOverride: null,
  unread: 0,
  carryoverNote: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: null,
    turns: 0,
    contextTokens: null,
    contextWindow: null,
  },
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
})
