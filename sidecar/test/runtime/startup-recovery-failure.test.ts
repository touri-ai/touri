import { expect, test } from "bun:test"
import { getStartupFixture, waitForStartup } from "./startup-fixture"

test.each(["starting", "running"] as const)("boot settles %s when history finalization rejects", async (status) => {
  const fixture = await getRecoveryFixture(status)
  const brokenStore = Object.assign({}, fixture.store, {
    updateThread: () => {
      throw new Error("Synthetic recovery history failure")
    },
  })
  fixture.kernel.services.provide("store.api", brokenStore)

  const reopened = fixture.open()
  await reopened.ready
  await reopened.waitForDrain()

  expect(fixture.persistence.getRun("previous-run")).toMatchObject({
    status: "interrupted",
    errorClass: "app_restart",
  })
  expect(reopened.getWorkRuns()).toEqual([])
  expect(fixture.startTurn).not.toHaveBeenCalled()
  expect(fixture.clock.getPendingCount()).toBe(0)
})

test.each([
  ["starting", false],
  ["running", false],
  ["starting", true],
  ["running", true],
] as const)(
  "boot bounds a blocked %s history flush and preserves Stop (%s)",
  async (status, stop) => {
    const fixture = await getRecoveryFixture(status)
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    const stalledStore = Object.assign({}, fixture.store, {
      flushWritesAsync: () => {
        entered.resolve()
        return blocked.promise
      },
    })
    fixture.kernel.services.provide("store.api", stalledStore)
    const reopened = fixture.open()
    let isReady = false
    void reopened.ready.then(() => {
      isReady = true
    })
    await entered.promise
    if (stop) reopened.cancel("previous-run")

    fixture.clock.advanceBy(4_999)

    expect(fixture.persistence.getRun("previous-run")?.status).toBe(status)
    fixture.clock.advanceBy(1)
    const expectedStatus = stop ? "canceled" : "interrupted"
    const settled = await waitForStartup(
      () => isReady && fixture.persistence.getRun("previous-run")?.status === expectedStatus,
    ).then(
      () => true,
      () => false,
    )
    const beforeFlush = fixture.persistence.getRun("previous-run")
    blocked.resolve()
    await reopened.ready
    await reopened.shutdown()

    expect(settled).toBe(true)
    expect(beforeFlush?.status).toBe(expectedStatus)
    expect(fixture.persistence.getRun("previous-run")?.status).toBe(expectedStatus)
    expect(reopened.getWorkRuns()).toEqual([])
    expect(fixture.startTurn).not.toHaveBeenCalled()
    expect(fixture.clock.getPendingCount()).toBe(0)
  },
  15_000,
)

const getRecoveryFixture = async (status: "starting" | "running") => {
  const fixture = await getStartupFixture({ resume: true })
  await fixture.engine.shutdown()
  fixture.persistence.saveRun({
    id: "previous-run",
    botId: "b",
    threadId: "t",
    provider: "codex",
    trigger: "user",
    requestMessageId: fixture.insertRequest(),
    replyMessageId: null,
    externalTurnId: status === "running" ? "accepted" : null,
    status,
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
  })
  return fixture
}
