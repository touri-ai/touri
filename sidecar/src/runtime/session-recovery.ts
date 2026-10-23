import type { MessagePart, RunErrorClass, StartTurnResult } from "@touri/contracts"

export const SESSION_RECOVERY_MESSAGE =
  "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão."

export const hasResumeDiagnostic = (text: string): boolean =>
  /No conversation found with session ID|(?:session|conversation)[^\n]{0,120}(?:not found|could not be (?:loaded|resumed)|cannot be resumed)|(?:failed|unable) to (?:resume|load) (?:session|conversation)/i.test(
    text,
  )

/** Initialization and thinking are not evidence that a resumed request was processed. */
export const hasTurnResponse = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => {
    if (part.type === "text") return !!part.text.trim()

    return part.type !== "reasoning" && part.type !== "notice"
  })

export const canRecoverSession = ({
  result,
  errorClass,
  hasResponse,
}: {
  result: StartTurnResult
  errorClass: RunErrorClass | null
  hasResponse: boolean
}): boolean => {
  if (hasResponse) return false
  if (!result.success) return result.errorCode === "cli_protocol"
  if (result.status === "interrupted") return false
  if (errorClass) return errorClass === "cli_protocol"

  return result.status === "succeeded"
}
