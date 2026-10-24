import { ApiError } from "../errors"

export type ConnectionStatus = Readonly<{
  state: "connecting" | "connected" | "offline" | "unavailable" | "session-expired" | "incompatible"
  attempt: number
  retryAt: number | null
  errorCode?: string
}>

export const getConnectionErrorCode = (error: unknown): string | undefined => {
  if (error instanceof ApiError) return error.errorCode
  if (!(error instanceof Error)) return undefined

  return error.message.match(/\b(?:SERVER|VAULT)_[A-Z_]+\b/)?.[0]
}

export const isSessionRejected = (error: unknown): boolean => {
  if (error instanceof ApiError) return error.status === 401
  if (!(error instanceof Error)) return false

  return /\bSERVER_(AUTH|UNAUTHORIZED|PAIRING_REQUIRED)\b/.test(error.message)
}

/** Native endpoint discovery cannot be cancelled, but its single shared caller can stop waiting. */
export const getWhileActive = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }

    signal.addEventListener("abort", abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
