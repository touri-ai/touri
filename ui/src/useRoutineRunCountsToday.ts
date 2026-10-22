import type { Routine, RoutineRun } from "@touri/contracts"
import { useEffect, useMemo, useState } from "react"
import { getNextRoutineRunDayBoundary, getRoutineRunCountsToday } from "./i18n"

export const useRoutineRunCountsToday = (
  routineRuns: readonly RoutineRun[],
  routines: ReadonlyMap<string, Routine>,
): ReadonlyMap<string, number> => {
  const [now, setNow] = useState(Date.now)
  const counts = useMemo(() => getRoutineRunCountsToday(routineRuns, routines, now), [routineRuns, routines, now])

  useEffect(() => {
    if (!routineRuns.length || !routines.size) return

    const nextBoundary = getNextRoutineRunDayBoundary(routines, now)
    if (nextBoundary === undefined) return

    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, nextBoundary - Date.now() + 1))
    const refresh = (): void => setNow(Date.now())
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible") refresh()
    }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refreshWhenVisible)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [routineRuns, routines, now])

  return counts
}
