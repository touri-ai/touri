import type { Run } from "@touri/contracts"
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
  ) {
    const publicCode = code ?? (isErrorCode(errorCode) ? errorCode : undefined)
    const definition = publicCode ? errorRegistry[publicCode] : undefined
    super(definition ? `${definition.message} [${publicCode}]` : userFacingError(message))
    this.name = "ApiError"
    this.diagnostic = message || this.message
    this.code = publicCode
    this.retryable = definition?.retryable ?? false
    this.domain = definition?.domain
    this.origin = definition?.origin
  }
}
