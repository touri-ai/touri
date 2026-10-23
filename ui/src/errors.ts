import { getGroupValidationError, type Run } from "@touri/contracts"
import { errorRegistry, isErrorCode, publicError, type RegisteredErrorCode } from "@touri/contracts/errors"

/** Keep transport metadata for control flow and present the friendly public message. */
export const userFacingError = (value: unknown): string => {
  const text = value instanceof Error ? value.message : String(value)
  return (
    text.replace(/^(?:Error:\s*)*(?:sidecar request failed:\s*\d{3}\s*(?:[·:]\s*)?)?(?:Error:\s*)*/i, "").trim() ||
    "Não foi possível concluir a solicitação. Tente novamente."
  )
}

export const userFacingRunError = (run: Pick<Run, "errorClass">): string => {
  const detail = publicError(run.errorClass)
  return `${detail.error} [${detail.code}]`
}

export class ApiError extends Error {
  readonly diagnostic: string
  readonly code: RegisteredErrorCode | undefined
  readonly retryable: boolean
  readonly domain: string | undefined
  readonly origin: string | undefined
  constructor(
    readonly status: number,
    message: string,
    readonly errorCode?: string,
    code?: RegisteredErrorCode,
    readonly retryAt?: number,
    field?: unknown,
  ) {
    const publicCode = code ?? (isErrorCode(errorCode) ? errorCode : undefined)
    const definition = publicCode ? errorRegistry[publicCode] : undefined
    const validation =
      publicCode === "TOURI-E1001" && errorCode === "INVALID_ARGS" ? getGroupValidationError(field) : undefined
    const publicMessage = validation?.error ?? definition?.message
    super(publicMessage ? `${publicMessage} [${publicCode}]` : userFacingError(message))
    this.name = "ApiError"
    this.diagnostic = message || this.message
    this.code = publicCode
    this.retryable = definition?.retryable ?? false
    this.domain = definition?.domain
    this.origin = definition?.origin
  }
}

export const isServiceUnavailable = (error: unknown): boolean =>
  error instanceof ApiError &&
  // E1009 also covers storage and execution failures on an otherwise reachable server.
  ((error.status === 0 && error.code === "TOURI-E1009") ||
    error.errorCode === "SERVER_CONNECTION_FAILED" ||
    error.status === 502 ||
    error.status === 504)
