import { expect, it } from "vitest"
import { getInteractionDurations } from "./e2e/onboarding-guide-timing"

it("retains the longest event for each interaction when later events finish sooner", () => {
  const samples = [
    { id: 1, duration: 120 },
    { id: 2, duration: 24 },
    { id: 1, duration: 16 },
    { id: 2, duration: 8 },
  ]

  expect(getInteractionDurations(samples)).toEqual([24, 120])
  expect(samples[0]?.duration).toBe(120)
})
it("keeps an empty measurement empty", () => {
  expect(getInteractionDurations([])).toEqual([])
})
