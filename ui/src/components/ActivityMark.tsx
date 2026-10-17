import type { MessagePart } from "@touri/contracts"
import type { AvatarIdentity } from "@touri/contracts/avatar"
import type { Locale } from "../i18n"
import { activityKindFor, activityLabelFor } from "./activityStatus"
import { BotAvatar } from "./BotAvatar"
import { type MascotState, mascotIsBusy, mascotPhaseFor } from "./mascotState"
import { useReducedMotion } from "./useReducedMotion"

const defaultBot = { id: "touri", name: "touri", color: null, avatarSeed: "touri-mascot" }

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
}: {
  state: MascotState
  parts?: readonly MessagePart[]
  bot?: AvatarIdentity | undefined
  threadId?: string | undefined
  onFocusApproval?: (approvalId: string) => void
  onExpandReasoning?: (() => void) | undefined
  reasoningId?: string | undefined
  reasoningExpanded?: boolean | undefined
  locale?: Locale
}) => {
  const reduced = useReducedMotion()
  const busy = mascotIsBusy(state)
  if (!busy && state !== "waiting-approval") return null
  const pending = parts.find((part) => part.type === "approval" && part.decision === "pending")
  const approvalId = pending?.type === "approval" ? pending.approvalId : undefined
  const label = activityLabelFor(state, parts, locale)
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
        ) : onExpandReasoning && parts.some((part) => part.type === "reasoning" && part.text.trim()) ? (
          <button
            type="button"
            className="activity-reasoning-button"
            aria-controls={reasoningId}
            aria-expanded={reasoningExpanded}
            onClick={onExpandReasoning}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </span>
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
