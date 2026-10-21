import { act, cleanup, renderHook } from "@testing-library/react"
import type { RoutineRun } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getRoutineRunCountsToday } from "../src/i18n"
import { useRoutineRunCountsToday } from "../src/useRoutineRunCountsToday"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("routine sidebar daily counts", () => {
  it("calculates one day boundary per routine timezone for a large run history", async () => {
    const { routineRuns, routines } = await getRoutineSidebarFixture(1, { todayRuns: true })
    const routine = routines[0]
    const sample = routineRuns[0]
    if (!routine || !sample) throw new Error("Missing routine fixture")

    const runs = Array.from({ length: 20_000 }, (_, index) => ({
      ...sample,
      id: `large-history-${index}`,
      routineId: index < 10_000 ? routine.id : `${routine.id}-other`,
      threadId: `large-history-thread-${index}`,
    }))
    const otherRoutine = { ...routine, id: `${routine.id}-other`, timezone: "Pacific/Auckland" }
    const readDayBounds = vi.fn((_now: number, _timeZone?: string) => ({ start: 0, end: Number.MAX_SAFE_INTEGER }))
    const counts = getRoutineRunCountsToday(
      runs,
      new Map([
        [routine.id, { ...routine, timezone: "UTC" }],
        [otherRoutine.id, otherRoutine],
      ]),
      Date.now(),
      readDayBounds,
    )

    expect(readDayBounds.mock.calls.map(([, timeZone]) => timeZone)).toEqual(["UTC", "Pacific/Auckland"])
    expect(counts.get(routine.id)).toBe(10_000)
    expect(counts.get(otherRoutine.id)).toBe(10_000)
  })

  it("expires today counts at the routine timezone's midnight with stable references", async () => {
    const { routineRuns, routines } = await getRoutineSidebarFixture(1)
    const routine = routines[0]
    const sample = routineRuns[0]
    if (!routine || !sample) throw new Error("Missing routine fixture")

    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-21T02:59:59.000Z"))
    const runs: RoutineRun[] = [
      {
        ...sample,
        id: "midnight-run",
        routineId: routine.id,
        scheduledFor: Date.parse("2026-10-21T02:59:58.000Z"),
        threadId: "midnight-thread",
      },
    ]
    const routineMap = new Map([[routine.id, { ...routine, timezone: "America/Sao_Paulo" }]])
    const hook = renderHook(() => useRoutineRunCountsToday(runs, routineMap))

    expect(hook.result.current.get(routine.id)).toBe(1)

    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    expect(hook.result.current.get(routine.id)).toBeUndefined()
    hook.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
