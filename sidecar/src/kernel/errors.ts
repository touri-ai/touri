import {
  errorRegistry,
  getGroupValidationError,
  getGroupValidationErrors,
  isErrorCode,
  publicError,
  type RegisteredErrorCode,
} from "@touri/contracts"

export class TouriError extends Error {
  constructor(
    readonly code: RegisteredErrorCode,
    options?: ErrorOptions,
  ) {
    super(errorRegistry[code].message, options)
    this.name = "TouriError"
  }
}

export const errorResponse = (value: unknown) => {
  const code =
    value instanceof TouriError ? value.code : value instanceof Error && "code" in value ? value.code : undefined
  const detail = publicError(code)
  return { status: errorRegistry[detail.code].status, json: { errorCode: detail.code, ...detail } }
}

export const normalizeErrorBody = (body: unknown, status: number): unknown => {
  if (status < 400) return body
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const detail = publicError(isErrorCode(record.code) ? record.code : record.errorCode, status)
  // Do not serialize raw exception messages, paths or secrets at the transport boundary.
  const errorCode =
    typeof record.errorCode === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(record.errorCode)
      ? record.errorCode
      : detail.code
  const validation =
    status === 400 && errorCode === "INVALID_ARGS" && detail.code === "TOURI-E1001"
      ? (getGroupValidationErrors(record.fields) ?? getGroupValidationError(record.field))
      : undefined

  return { errorCode, ...detail, ...validation }
}
