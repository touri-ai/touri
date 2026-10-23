import { expect, test } from "bun:test"
import { getStartupFixture, waitForStartup } from "./startup-fixture"

test("a rejected preparation fails durably and releases the slot for the next request", async () => {
  let calls = 0
  const fixture = await getStartupFixture({
    shellEnv: async () => {
      calls += 1
      if (calls === 1) throw new Error("Synthetic environment discovery failure")
      return { PATH: "/usr/bin" }
    },
  })
  const run = fixture.enqueue()
  const next = fixture.enqueue("next")

  await waitForStartup(
    () =>
      fixture.persistence.getRun(run.id)?.status === "failed" &&
      fixture.persistence.getRun(next.id)?.status === "succeeded",
  )

  expect(fixture.persistence.getRun(run.id)).toMatchObject({ errorClass: "unknown" })
  expect(fixture.persistence.getRun(run.id)?.providerStartedAt ?? null).toBeNull()
  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(fixture.startTurn).toHaveBeenCalledTimes(1)
  expect(fixture.clock.getPendingCount()).toBe(0)
  expect(fixture.engine.getRetainedRunStateCount()).toBe(0)
})

test("failure to write the reply cannot retain a starting run in durable storage", async () => {
  const fixture = await getStartupFixture({
    shellEnv: async () => {
      throw new Error("Synthetic preparation failure")
    },
  })
  const brokenStore = Object.assign({}, fixture.store, {
    updateThread: () => {
      throw new Error("Synthetic reply finalization failure")
    },
  })
  fixture.kernel.services.provide("store.api", brokenStore)
  const run = fixture.enqueue()

  await waitForStartup(
    () =>
      fixture.persistence.getRun(run.id)?.status === "failed" && fixture.engine.activeRun({ threadId: "t" }) === null,
  )

  expect(fixture.persistence.getRun(run.id)).toMatchObject({ status: "failed", errorClass: "unknown" })
  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(fixture.startTurn).not.toHaveBeenCalled()
})

test("a stalled history flush cannot retain the run or prevent shutdown", async () => {
  const fixture = await getStartupFixture({
    shellEnv: async () => {
      throw new Error("Synthetic preparation failure")
    },
  })
  const blocked = Promise.withResolvers<void>()
  const stalledStore = Object.assign({}, fixture.store, {
    flushWritesAsync: async () => {
      blocked.resolve()
      await new Promise<void>(() => {})
    },
  })
  fixture.kernel.services.provide("store.api", stalledStore)
  const run = fixture.enqueue()
  await blocked.promise

  fixture.clock.advanceBy(4_999)

  expect(fixture.persistence.getRun(run.id)?.status).toBe("starting")
  fixture.clock.advanceBy(1)
  await waitForStartup(
    () =>
      fixture.persistence.getRun(run.id)?.status === "failed" && fixture.engine.activeRun({ threadId: "t" }) === null,
  )
  await fixture.engine.shutdown()

  expect(fixture.engine.getWorkRuns()).toEqual([])
  expect(fixture.clock.getPendingCount()).toBe(0)
})
