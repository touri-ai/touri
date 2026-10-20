import { apiModelErrors, errorRegistry, type MessagePart, type Provider, publicError } from "@touri/contracts"
import { hasRecordedActions, isModelAtCapacity, safeRunFailure, sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { providerName } from "./components/ProviderMark"
import { ApiError, isServiceUnavailable } from "./errors"
import { type Locale, t } from "./i18n"

export type RecoveryAction = "retry" | "login" | "storage" | "review" | "resume" | "doctor"
export type RecoveryContext = {
  provider?: Provider | undefined
  errorClass?: string | null | undefined
  parts?: MessagePart[] | undefined
  savedMessage?: boolean | undefined
  file?: string | undefined
  locale?: Locale | undefined
  now?: number | undefined
  occurredAt?: number | undefined
}
export type ErrorRecovery = {
  message: string
  diagnostic: string
  actions: Array<{ kind: RecoveryAction; label: string }>
  classified: boolean
}

/** One projection for failures from transport, persisted runs and older notices. */
export const errorRecovery = (error: unknown, context: RecoveryContext = {}): ErrorRecovery => {
  const raw =
    error instanceof ApiError ? error.diagnostic : error instanceof Error ? error.message : String(error ?? "")
  const text = `${context.errorClass ?? ""} ${error instanceof ApiError ? `${error.code ?? ""} ${error.errorCode ?? ""}` : ""} ${raw}`
  const locale = context.locale ?? "pt-BR"
  const tr = (key: Parameters<typeof t>[0], params: Record<string, string | number> = {}) => t(key, params, locale)
  const provider = context.provider ? providerName(context.provider) : tr("seu provedor")
  const diagnostic = sanitizeDiagnostic(`${error instanceof ApiError && error.code ? `${error.code} · ` : ""}${raw}`)
  const action = (kind: RecoveryAction, label: Parameters<typeof t>[0]) => ({ kind, label: tr(label) })
  const view = (message: string, actions: ErrorRecovery["actions"], classified = true): ErrorRecovery => ({
    message,
    diagnostic,
    actions,
    classified,
  })
  if (context.errorClass === "group_context_missing")
    return view(tr("O grupo ou a conversa não existe mais. Este turno não foi executado."), [])
  // A recorded tool invocation may have committed even when its acknowledgement is absent.
  if (
    hasRecordedActions(context.parts ?? []) ||
    /TOURI-E1010|app_restart|confirmação.*(?:perdida|confirmar)|não foi possível confirmar|algumas ações podem/i.test(
      text,
    )
  )
    return view(tr("A resposta foi interrompida. Algumas ações podem ter sido concluídas."), [
      action("review", "Ver ações realizadas"),
      action("resume", "Retomar tarefa"),
    ])
  if (
    (error instanceof ApiError && error.status === 507) ||
    /ENOSPC|no space left|disk full|TOURI-E2002|espaço.*disco|não há espaço/i.test(text)
  )
    return view(tr("Não há espaço para salvar {arquivo}.", { arquivo: context.file ?? tr("o arquivo") }), [
      action("storage", "Verificar armazenamento"),
    ])
  const apiMessage = Object.values(apiModelErrors).find((message) => raw.includes(message))
  if (apiMessage) return view(tr(apiMessage), [action("retry", "Tentar novamente")])
  const invalidModelMessage = "The saved model name is invalid. Choose another model in the bot settings."
  if (raw.includes(invalidModelMessage)) return view(tr(invalidModelMessage), [])

  if (
    (error instanceof ApiError && error.status === 401) ||
    /\b401\b|unauthori[sz]ed|cli_auth|TOURI-E3001|sessão expir|entre na.*conta.*provedor/i.test(text)
  )
    return view(tr("Entre novamente no {provedor} para continuar.", { provedor: provider }), [
      action("login", "Entrar na conta"),
    ])
  if (isModelAtCapacity(raw))
    return view(
      `${tr("O modelo selecionado está sem capacidade no momento.")} ${tr("Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.")}`,
      [action("review", "Ver tarefa")],
    )
  if (
    (error instanceof ApiError && error.status === 429) ||
    /\b429\b|rate_limit|TOURI-E1006|limite.*(?:uso|solicitações)|too many requests/i.test(text)
  ) {
    const now = context.now ?? Date.now()
    const seconds = /(?:retry[-_ ]after|tente após)\s*[:=]?\s*(\d{1,6})(?:\s*(?:s|seconds|segundos))?\b/i.exec(raw)?.[1]
    const iso = /\b\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)\b/.exec(raw)?.[0]
    const retryAt =
      error instanceof ApiError && error.retryAt !== undefined
        ? error.retryAt
        : iso
          ? Date.parse(iso)
          : seconds
            ? (context.occurredAt ?? now) + Number(seconds) * 1000
            : undefined
    const deadline =
      retryAt !== undefined && Number.isFinite(retryAt) && retryAt > now
        ? new Date(retryAt).toLocaleString(locale, {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null
    return view(
      deadline
        ? tr("O {provedor} atingiu o limite de uso. Tente após {horario}.", { provedor: provider, horario: deadline })
        : tr("O {provedor} atingiu o limite de uso. Tente mais tarde.", { provedor: provider }),
      [action("review", "Ver tarefa")],
    )
  }
  if (isServiceUnavailable(error) || /SERVER_CONNECTION_FAILED/i.test(text))
    return view(tr("O serviço do touri está indisponível. Verifique a conexão e tente novamente."), [
      action("retry", "Tentar novamente"),
    ])
  if (
    /network|fetch failed|failed to fetch|ECONN|ENET|EHOST|sem conexão|não.*conectar|conexão.*(?:encerrada|interrompida)/i.test(
      text,
    )
  )
    return view(
      context.savedMessage
        ? tr("Não consegui conectar à sua IA. Sua mensagem está salva.")
        : tr("Não consegui conectar à sua IA. Verifique a conexão e tente novamente."),
      [action("retry", "Tentar novamente")],
    )
  const known = Object.values(errorRegistry).find((entry) => raw.includes(entry.message))
  const projected = safeRunFailure(context.errorClass ?? null, raw)
  const safeKnown = projected.stage !== "turn" && !/provider_protocol|provider_install/.test(projected.stage)
  return view(
    known?.message ??
      (safeKnown ? projected.detail : tr("Não foi possível concluir esta ação. Confira os detalhes do erro.")),
    [
      ...(context.errorClass && publicError(context.errorClass).retryable ? [action("retry", "Tentar novamente")] : []),
      action("doctor", "Verificar ambiente"),
    ],
    false,
  )
}
