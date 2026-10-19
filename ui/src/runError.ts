import type { Message, Run } from "@touri/contracts"
import { apiModelErrors, errorRegistry, publicError } from "@touri/contracts"
import {
  type FailureAction,
  failureRetryHint,
  failureStageLabel,
  isModelAtCapacity,
  type RunFailureDetail,
  safeRunFailure,
  sanitizeDiagnostic,
} from "@touri/contracts/run-failure"
import { type ErrorRecovery, errorRecovery } from "./errorRecovery"
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
  app_restart: t("A resposta foi interrompida ao reiniciar o touri"),
}

const REGISTRY_MESSAGES: ReadonlyArray<string> = Object.values(errorRegistry).map((definition) => definition.message)

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
  const apiMessage = Object.values(apiModelErrors).find((text) => (run?.errorMessage ?? raw).includes(text))
  return {
    title: modelIsAtCapacity ? t("Modelo temporariamente sem capacidade") : (TITLES[errorClass] ?? FALLBACK_TITLE),
    ...rest,
    detail: apiMessage ? t(apiMessage) : detail,
    code: publicError(errorClass).code,
    stageLabel: failureStageLabel(failure.stage),
    hint:
      machineReady && /^(?:machine_boot|sealed_connection)$/.test(failure.stage)
        ? failureRetryHint(failure.stage, true)
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

export const failureTimeLabel = (timestamp: number, now = Date.now()): string => {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  const day = date.toLocaleDateString("pt-BR")
  const relativeDay =
    day === today.toLocaleDateString("pt-BR")
      ? "hoje"
      : day === yesterday.toLocaleDateString("pt-BR")
        ? "ontem"
        : `em ${day}`
  return `falhou ${relativeDay} às ${date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
}
