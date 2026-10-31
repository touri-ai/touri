import { resolveErrorCode } from "@touri/contracts/errors"
import { sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { ApiError, isServiceUnavailable } from "./errors"

export type HistoryFailureKind = "offline" | "deleted" | "restarting" | "server"
export type HistoryFailure = {
  kind: HistoryFailureKind
  code: string
  diagnostic: string
  threadId?: string | undefined
  /** The conversation index failed, not this conversation's messages; the next full load clears it. */
  index?: boolean | undefined
}

/** Wait before the single automatic retry; long enough for a restarted server to listen again. */
export const historyRetryDelayMs = 1200

/** Classify a failed conversation read so the notice names the real cause. */
export const getHistoryFailure = (error: unknown, online = isBrowserOnline()): HistoryFailure => {
  const status = error instanceof ApiError ? error.status : 0
  const errorCode = error instanceof ApiError ? error.errorCode : undefined
  const code = error instanceof ApiError ? (error.code ?? resolveErrorCode(errorCode, status || 503)) : "TOURI-E1000"
  const raw = error instanceof ApiError ? error.diagnostic : error instanceof Error ? error.message : String(error)
  const diagnostic = sanitizeDiagnostic(
    [code, errorCode, status ? `HTTP ${status}` : "", raw].filter(Boolean).join(" · "),
  )

  if (!online) return { kind: "offline", code, diagnostic }
  if (isDeletedConversation(error)) return { kind: "deleted", code, diagnostic }
  if (errorCode === "RUNTIME_DRAINING") return { kind: "restarting", code, diagnostic }

  return { kind: "server", code, diagnostic }
}

/** A deleted conversation never comes back, so it is the one read that is not retried. */
export const isDeletedConversation = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 404 &&
  (error.errorCode === undefined || /^(?:NOT_FOUND|THREAD_NOT_FOUND)$/.test(error.errorCode))

/** The request never reached a running server, so every read of the conversation fails for the same reason. */
export const isUnreachable = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 0 || error.errorCode === "SERVER_CONNECTION_FAILED")

/**
 * The server could not answer the read: unreachable, refused by a proxy in front of it, or failing while it stops.
 * Saved history stays readable, so the failure belongs inside the open conversation, not in an app-wide notice.
 */
export const isServerReadFailure = (error: unknown): boolean =>
  isUnreachable(error) || isServiceUnavailable(error) || (error instanceof ApiError && error.status >= 500)

export const isRetryableHistoryError = (error: unknown): boolean =>
  !isDeletedConversation(error) &&
  !(error instanceof DOMException && error.name === "AbortError") &&
  (!(error instanceof ApiError) || isServiceUnavailable(error) || error.status === 0 || error.status >= 500)

/** Run a read once more after a short backoff when its failure can be transient. */
export const getWithRetry = async <T>(
  read: () => Promise<T>,
  { signal, delayMs = historyRetryDelayMs }: { signal: AbortSignal; delayMs?: number },
): Promise<T> => {
  try {
    return await read()
  } catch (error) {
    if (signal.aborted || !isRetryableHistoryError(error)) throw error
    await waitFor(delayMs, signal)
    return read()
  }
}

const waitFor = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, delayMs)
    signal.addEventListener("abort", abort, { once: true })
  })

const isBrowserOnline = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false
