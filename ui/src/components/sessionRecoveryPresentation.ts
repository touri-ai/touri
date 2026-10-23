import type { Message, MessagePart, Run } from "@touri/contracts"

export const sessionRecoveryDiagnosticText =
  "A sessão anterior não pôde ser retomada. Vou continuar com o histórico salvo em uma nova sessão."

export const isSessionRecoveryDiagnostic = (part: MessagePart): boolean =>
  part.type === "notice" &&
  part.level === "info" &&
  part.code === "run_resumed" &&
  part.text === sessionRecoveryDiagnosticText

/** Only inspect a fixed neighborhood of a mounted row; distant or uncertain notices stay visible. */
export const getSessionRecoveryPresentation = (
  message: Message,
  neighbors: readonly Message[],
  runsById: ReadonlyMap<string, Run>,
): Message | null => {
  if (isSessionRecoveryMarker(message)) {
    const recovered = neighbors.some(
      (candidate) =>
        candidate.role === "assistant" &&
        isRecoveredSessionRun(runsById.get(candidate.runId ?? ""), message.runId, runsById),
    )

    return recovered ? null : message
  }
  if (message.role !== "assistant") return message
  const run = runsById.get(message.runId ?? "")
  if (run?.status !== "succeeded") return message
  const diagnostics = neighbors
    .filter((candidate) => isSessionRecoveryMarker(candidate) && isRecoveredSessionRun(run, candidate.runId, runsById))
    .flatMap((candidate) => candidate.parts)
  if (!diagnostics.length) return message

  return Object.assign({}, message, { parts: diagnostics.concat(message.parts) })
}

const isSessionRecoveryMarker = (message: Message): boolean =>
  message.role === "system" &&
  message.kind === "notice" &&
  message.parts.length > 0 &&
  message.parts.every(isSessionRecoveryDiagnostic) &&
  message.text === sessionRecoveryDiagnosticText

const isRecoveredSessionRun = (
  run: Run | undefined,
  diagnosticRunId: string | null,
  runsById: ReadonlyMap<string, Run>,
): boolean => {
  if (run?.status !== "succeeded" || !diagnosticRunId) return false

  // Match explicit recovery ancestry, never an unrelated later successful answer.
  let current: Run | undefined = run
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (current.id === diagnosticRunId) return true
    current = runsById.get(current.automaticResumeFromRunId ?? "")
  }
  return false
}
