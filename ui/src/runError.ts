import type { Message, Run } from "@touri/contracts"
import { publicError } from "@touri/contracts"
import {
  type FailureAction,
  failureRetryHint,
  failureStageLabel,
  isModelAtCapacity,
  PROVIDER_MEMORY_DETAIL,
  PROVIDER_MEMORY_HINT,
  type RunFailureDetail,
  safeRunFailure,
  sanitizeDiagnostic,
} from "@touri/contracts/run-failure"
import { getAttachmentError } from "./attachmentError"
import { type ErrorRecovery, errorRecovery, getRetryMessage, REGISTRY_MESSAGES } from "./errorRecovery"
import { t } from "./i18n"

export type RunErrorView = Omit<RunFailureDetail, "hint"> & {
  title: string
  code: string
  stageLabel: string
  hint: string
  specificHint: boolean
  recovery: ErrorRecovery
}

const TITLES: Record<string, string> = {
  cli_missing: t("Não encontrei o programa do provedor"),
  cli_auth: t("O provedor não está autenticado"),
  cli_crash: t("O provedor encerrou inesperadamente"),
  cli_protocol: t("Resposta inesperada do provedor"),
  rate_limit: t("Limite de uso do provedor atingido"),
  context_overflow: t("A conversa ficou grande demais"),
  timeout: t("A execução demorou demais"),
  machine_service_unavailable: publicError("MACHINE_SERVICE_UNAVAILABLE").error,
  machine_service_start_failed: publicError("MACHINE_SERVICE_START_FAILED").error,
  group_context_missing: t("O grupo ou a conversa não existe mais"),
  app_restart: t("A resposta foi interrompida ao reiniciar o touri"),
}

const legacyDiagnostic = (raw: string): string | null => {
  const text = raw
    .replace(/^[a-z_]+:\s*/, "")
    .replace(/\s*\[TOURI-E\d+\]\s*$/, "")
    .trim()
  return text && !REGISTRY_MESSAGES.includes(text) ? text : null
}

const ACTION_KINDS: ReadonlyArray<string> = ["setting", "doctor", "machine_service"]

const trustedAction = (action: FailureAction | undefined): FailureAction | undefined =>
  action && ACTION_KINDS.includes(action.kind) ? { ...action, label: sanitizeDiagnostic(action.label) } : undefined

/** A stored failure is data from storage: re-project it onto known phrases or sanitize it before display. */
const trustedFailure = (errorClass: string, stored: RunFailureDetail): RunFailureDetail => {
  const projected = safeRunFailure(errorClass, stored.detail)
  if (projected.stage !== "turn" || isModelAtCapacity(projected.detail)) return projected
  const action = trustedAction(stored.action)
  return {
    stage: stored.stage,
    detail: sanitizeDiagnostic(stored.detail),
    ...(stored.hint ? { hint: sanitizeDiagnostic(stored.hint) } : {}),
    ...(action ? { action } : {}),
  }
}

const FALLBACK_TITLE = t("Não foi possível concluir a resposta")
const ORPHANED_GROUP_TURN_PT = "O grupo ou a conversa não existe mais. Este turno não foi executado."

/** Resolve old generic notices from the run already loaded with the thread; sanitize both sources. */
export const runErrorFor = (message: Message, candidate?: Run, machineReady = false): RunErrorView | null => {
  if (message.status !== "failed") return null
  const run = candidate?.id === message.runId && candidate.threadId === message.threadId ? candidate : undefined
  const notice = message.parts.find((part) => part.type === "notice" && part.level === "error")
  const raw = notice?.type === "notice" ? notice.text : message.text
  const separator = raw.indexOf(":")
  const errorClass = run?.errorClass ?? (separator > 0 ? raw.slice(0, separator).trim() : "")
  const stored = notice?.type === "notice" ? notice.failure : undefined
  const fromRun = run?.errorMessage ? safeRunFailure(errorClass, run.errorMessage) : null
  const failure =
    (stored && trustedFailure(errorClass, stored)) ?? fromRun ?? safeRunFailure(errorClass, legacyDiagnostic(raw))
  const { hint, ...rest } = failure
  const modelIsAtCapacity = isModelAtCapacity(failure.detail)
  const detail = modelIsAtCapacity ? t("O modelo selecionado está sem capacidade no momento.") : rest.detail
  const recoveryHint = modelIsAtCapacity
    ? t("Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.")
    : hint
  const retryMessage = getRetryMessage(`${run?.errorMessage ?? raw} ${detail}`)
  const getLocalizedDetail = (): string => {
    if (run?.errorMessage === "O bot terminou sem responder. Tente novamente.")
      return t("O bot terminou sem responder. Tente novamente.")
    if (run?.errorMessage === ORPHANED_GROUP_TURN_PT) return t(ORPHANED_GROUP_TURN_PT)
    const attachmentError = getAttachmentError(run?.errorMessage ?? raw)
    if (attachmentError) return attachmentError
    if (retryMessage) return t(retryMessage)
    if (failure.stage === "provider_memory") return t(PROVIDER_MEMORY_DETAIL)

    return detail
  }

  return {
    title: modelIsAtCapacity ? t("Modelo temporariamente sem capacidade") : (TITLES[errorClass] ?? FALLBACK_TITLE),
    ...rest,
    detail: getLocalizedDetail(),
    code: publicError(errorClass).code,
    stageLabel: failureStageLabel(failure.stage),
    hint:
      machineReady && /^(?:machine_boot|sealed_connection)$/.test(failure.stage)
        ? failureRetryHint(failure.stage, true)
        : failure.stage === "provider_memory"
          ? t(PROVIDER_MEMORY_HINT)
          : (recoveryHint ?? failureRetryHint(failure.stage, machineReady)),
    specificHint: recoveryHint !== undefined,
    recovery: errorRecovery(run?.errorMessage ?? raw, {
      errorClass,
      provider: run?.provider,
      parts: message.parts,
      savedMessage: !!run?.requestMessageId,
      occurredAt: run?.finishedAt ?? message.updatedAt,
    }),
  }
}

// Intl formatters are costly to build; one instance serves every render of a failed message.
const failureDay = new Intl.DateTimeFormat("pt-BR")
const failureClock = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" })

export const failureTimeLabel = (timestamp: number, now = Date.now()): string => {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  const day = failureDay.format(date)
  const time = failureClock.format(date)
  if (day === failureDay.format(today)) return `falhou hoje às ${time}`
  if (day === failureDay.format(yesterday)) return `falhou ontem às ${time}`

  return `falhou em ${day} às ${time}`
}
