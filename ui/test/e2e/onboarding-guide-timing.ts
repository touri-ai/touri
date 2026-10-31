export const getInteractionDurations = (samples: ReadonlyArray<{ id: number; duration: number }>): number[] =>
  Array.from(Map.groupBy(samples, (sample) => sample.id).values())
    .map((events) => events.reduce((longest, event) => Math.max(longest, event.duration), 0))
    .toSorted((left, right) => left - right)
