import type { MessagePart, Run } from "@touri/contracts"
import type { AvatarIdentity } from "@touri/contracts/avatar"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { getQueueLabel } from "../features/work/presentation"
import { type Locale, t } from "../i18n"
import { activeToolFor, activityKindFor, activityLabelFor } from "./activityStatus"
import { BotAvatar } from "./BotAvatar"
import { type MascotState, mascotIsBusy, mascotPhaseFor } from "./mascotState"
import { useReducedMotion } from "./useReducedMotion"

const defaultBot = {
  id: "touri",
  name: "touri",
  color: "#e8483f",
  avatarShape: "classic-none" as const,
  avatarSeed: "touri-mascot",
}

export const ActivityMark = ({
  state,
  parts = [],
  bot = defaultBot,
  threadId,
  onFocusApproval,
  onExpandReasoning,
  reasoningId,
  reasoningExpanded,
  locale = "pt-BR",
  run,
  updatedAt,
  preparingEnvironment = false,
  api,
  onCancel,
}: {
  state: MascotState
  parts?: readonly MessagePart[]
  bot?: AvatarIdentity | undefined
  threadId?: string | undefined
  onFocusApproval?: ((approvalId: string) => void) | undefined
  onExpandReasoning?: (() => void) | undefined
  reasoningId?: string | undefined
  reasoningExpanded?: boolean | undefined
  locale?: Locale
  run?: Run | undefined
  updatedAt?: number | undefined
  preparingEnvironment?: boolean | undefined
  api?: UiApi | undefined
  onCancel?: ((runId: string) => Promise<void>) | undefined
}) => {
  const reduced = useReducedMotion()
  const busy = mascotIsBusy(state)
  const [now, setNow] = useState(Date.now)
  const [checking, setChecking] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [connection, setConnection] = useState({ at: 0, text: "" })
  const [stopError, setStopError] = useState(false)
  const waiting = state === "waiting-approval"
  const wasWaiting = useRef(waiting)
  const [resumedAt, setResumedAt] = useState(0)
  useLayoutEffect(() => {
    if (wasWaiting.current && !waiting) setResumedAt(Date.now())
    wasWaiting.current = waiting
  }, [waiting])
  const providerAt = run?.providerStartedAt ?? (run?.status === "running" ? run.startedAt : null)
  const since = Math.max(providerAt ?? run?.queuedAt ?? now, updatedAt ?? 0, resumedAt)
  const terminal = run && !["queued", "starting", "running"].includes(run.status)
  const active = Boolean(busy && !terminal && run)
  useEffect(() => {
    if (!active) return
    // Only wake at a copy boundary; a silent provider needs no periodic renders.
    const timers = [10_000, 30_000]
      .filter((delay) => since + delay > Date.now())
      .map((delay) => setTimeout(() => setNow(Date.now()), Math.max(0, since + delay - Date.now())))
    return () => timers.forEach(clearTimeout)
  }, [active, since])

  // Async connection results from a previous activity must not reappear in a new turn.
  useEffect(() => {
    setConnection({ at: since, text: "" })
    setStopError(false)
  }, [since])
  if (terminal || (!busy && state !== "waiting-approval")) return null
  const pending = parts.find((part) => part.type === "approval" && part.decision === "pending")
  const approvalId = pending?.type === "approval" ? pending.approvalId : undefined
  const quietMs = Math.max(0, now - since)
  const preparingComputer = preparingEnvironment && !providerAt
  const slow = run?.status !== "queued" && !waiting && !preparingComputer && quietMs >= 30_000
  const label = getActivityLabel({ run, state, parts, locale, slow, preparingComputer, quietMs, providerAt })
  return (
    <div
      className="activity-mark"
      data-mascot-state={state}
      data-mascot-phase={mascotPhaseFor(state)}
      data-activity={activityKindFor(state, parts)}
      data-reduced-motion={reduced}
    >
      <span className="activity-mascot" aria-hidden="true">
        <BotAvatar bot={bot} still size={24} state={state} {...(threadId ? { threadId } : {})} />
      </span>
      {waiting && approvalId && onExpandReasoning && (
        <button
          type="button"
          className="turn-activity-toggle"
          aria-label={t("Ver atividade", {}, locale)}
          aria-controls={reasoningId}
          aria-expanded={reasoningExpanded}
          onClick={onExpandReasoning}
        >
          <svg
            className="turn-activity-chevron"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      )}
      <div className="activity-copy">
        <span className="activity-label" role="status" aria-atomic="true">
          {state === "waiting-approval" && approvalId ? (
            <a
              className="activity-approval-link"
              href={`#approval-${approvalId}`}
              onClick={(event) => {
                if (!onFocusApproval) return
                event.preventDefault()
                onFocusApproval(approvalId)
              }}
            >
              {label}
              <span aria-hidden="true"> ↗</span>
            </a>
          ) : onExpandReasoning ? (
            <button
              type="button"
              className="activity-reasoning-button turn-activity-toggle"
              aria-controls={reasoningId}
              aria-expanded={reasoningExpanded}
              onClick={onExpandReasoning}
            >
              <svg
                className="turn-activity-chevron"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path d="m9 5 7 7-7 7" />
              </svg>
              {label}
            </button>
          ) : (
            label
          )}
        </span>
        {slow && (
          <div className="activity-delay">
            <div className="activity-delay-actions">
              {api && (
                <button
                  type="button"
                  className="text-button"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true)
                    setConnection({ at: since, text: "" })
                    try {
                      await api.request("GET /health", {})
                      setConnection({
                        at: since,
                        text: t("A conexão com o touri está disponível. A IA pode continuar demorando.", {}, locale),
                      })
                    } catch {
                      setConnection({
                        at: since,
                        text: t("Não foi possível conectar ao touri. Verifique sua conexão.", {}, locale),
                      })
                    } finally {
                      setChecking(false)
                    }
                  }}
                >
                  {checking ? t("Verificando conexão…", {}, locale) : t("Verificar conexão", {}, locale)}
                </button>
              )}
              {run && onCancel && (
                <button
                  type="button"
                  className="text-button"
                  disabled={stopping}
                  onClick={async () => {
                    setStopping(true)
                    setStopError(false)
                    try {
                      await onCancel(run.id)
                    } catch {
                      setStopError(true)
                    } finally {
                      setStopping(false)
                    }
                  }}
                >
                  {stopping ? t("Stopping reply…", {}, locale) : t("Parar", {}, locale)}
                </button>
              )}
            </div>
            {connection.at === since && connection.text && <p role="status">{connection.text}</p>}
            {stopError && <p role="alert">{t("Não foi possível parar. Tente novamente.", {}, locale)}</p>}
          </div>
        )}
      </div>
      {busy && (
        <span className="activity-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  )
}

const getActivityLabel = ({
  run,
  state,
  parts,
  locale,
  slow,
  preparingComputer,
  quietMs,
  providerAt,
}: {
  run: Run | undefined
  state: MascotState
  parts: readonly MessagePart[]
  locale: Locale
  slow: boolean
  preparingComputer: boolean
  quietMs: number
  providerAt: number | null | undefined
}): string => {
  if (run?.status === "queued") return getQueueLabel(run, locale)
  if (state === "waiting-approval") return activityLabelFor(state, parts, locale)
  if (slow) return t("A resposta está demorando. Você pode continuar esperando ou verificar a conexão.", {}, locale)
  if (preparingComputer) return t("Ligando o computador do bot…", {}, locale)
  if (quietMs >= 10_000 && activeToolFor(parts)) return t("A tarefa continua em execução.", {}, locale)
  if (quietMs >= 10_000 && providerAt) return t("Ainda aguardando a IA responder.", {}, locale)

  return activityLabelFor(state, parts, locale)
}
