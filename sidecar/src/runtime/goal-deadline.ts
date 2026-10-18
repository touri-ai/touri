export type GoalDeadlineClock = {
  now: () => number
  schedule: (callback: () => void, delay: number) => () => void
}

export const startGoalDeadline = (
  deadlineAt: number,
  expire: () => void,
  clock: GoalDeadlineClock = { now: Date.now, schedule: scheduleTimeout },
) => {
  // A live turn owns one timer; budget edits replace that resource in place.
  let currentDeadlineAt = deadlineAt
  let cancelTimeout = clock.schedule(expire, Math.max(0, deadlineAt - clock.now()))

  return {
    setDeadline: (nextDeadlineAt: number) => {
      if (nextDeadlineAt === currentDeadlineAt) return

      cancelTimeout()
      currentDeadlineAt = nextDeadlineAt
      cancelTimeout = clock.schedule(expire, Math.max(0, nextDeadlineAt - clock.now()))
    },
    stop: () => cancelTimeout(),
  }
}

const scheduleTimeout: GoalDeadlineClock["schedule"] = (callback, delay) => {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}
