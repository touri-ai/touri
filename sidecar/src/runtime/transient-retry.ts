import { delay } from "./utils"

const DATABASE_LOCKED = /database is locked|SQLITE_BUSY|database table is locked/i
const SERVICE_DOWN = /failed to list containers|XPC connection|Connection invalid|container system (?:service|start)/i
const WORKSPACE_ROUTING_DISCOVERY = /workspace routing discovery failed/i
const DATABASE_DELAYS_MS: ReadonlyArray<number> = [500, 1_500, 4_000]
const SERVICE_DELAYS_MS: ReadonlyArray<number> = [2_000]
const WORKSPACE_ROUTING_DELAYS_MS: ReadonlyArray<number> = [1_000]

const getRetryDelays = (message: string): ReadonlyArray<number> => {
  if (DATABASE_LOCKED.test(message)) return DATABASE_DELAYS_MS
  if (SERVICE_DOWN.test(message)) return SERVICE_DELAYS_MS
  if (WORKSPACE_ROUTING_DISCOVERY.test(message)) return WORKSPACE_ROUTING_DELAYS_MS

  return []
}

export type RetryTransientArgs<T> = {
  run: () => Promise<T>
  failureOf: (value: T) => string | null
  canRetry: () => boolean
  signal: AbortSignal
}

type Attempt<T> =
  | { settled: "fulfilled"; value: T; message: string | null }
  | { settled: "rejected"; error: unknown; message: string }

const getErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const getAttempt = <T>(run: () => Promise<T>, failureOf: (value: T) => string | null): Promise<Attempt<T>> =>
  run().then(
    (value): Attempt<T> => ({ settled: "fulfilled", value, message: failureOf(value) }),
    // Bookkeeping before the provider starts can throw the same transient lock a failed outcome reports.
    (error: unknown): Attempt<T> => ({ settled: "rejected", error, message: getErrorMessage(error) }),
  )

const getSettledValue = <T>(attempt: Attempt<T>): T => {
  if (attempt.settled === "rejected") throw attempt.error
  return attempt.value
}

/** Re-run an operation after a transient database, service or workspace-route failure, returned or thrown. */
export const retryTransient = async <T>({ run, failureOf, canRetry, signal }: RetryTransientArgs<T>): Promise<T> => {
  const retry = async (retriesUsed: number): Promise<T> => {
    const attempt = await getAttempt(run, failureOf)
    const wait = attempt.message ? getRetryDelays(attempt.message)[retriesUsed] : undefined
    if (wait === undefined || signal.aborted || !canRetry()) return getSettledValue(attempt)
    await delay({ milliseconds: wait, signal }).catch(() => undefined)
    return retry(retriesUsed + 1)
  }
  return retry(0)
}
