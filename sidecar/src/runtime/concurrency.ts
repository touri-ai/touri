export const getDefaultMaxConcurrentRuns = (env: Record<string, string | undefined>): number => {
  const limit = Number(env.TOURI_MAX_CONCURRENT_RUNS ?? 3)
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) return 3

  return limit
}
