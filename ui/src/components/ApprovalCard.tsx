import type { ApprovalPart } from "@touri/contracts"
import { useId, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { TeamApprovalCard } from "./TeamApprovalCard"
import { ToolCallCard } from "./ToolCallCard"
import { type ToolPart, toolPresentation } from "./toolPresentation"

export const ApprovalCard = (props: Parameters<typeof GenericApprovalCard>[0]) =>
  props.part.scope?.source === "mcp" &&
  props.part.scope.server === "touri" &&
  props.part.scope.tool === "team_create" ? (
    <TeamApprovalCard {...props} />
  ) : (
    <GenericApprovalCard {...props} />
  )

const GenericApprovalCard = ({
  part,
  api,
  tool,
  finished,
  createdAt,
  resolvedAt,
  onResolved,
}: {
  part: ApprovalPart
  api?: UiApi | undefined
  tool?: ToolPart | undefined
  finished?: boolean | undefined
  createdAt?: number | undefined
  resolvedAt?: number | undefined
  onResolved?: (timestamp: number, decision: "approved" | "denied") => void
}) => {
  const tooltipId = useId()
  const answering = useRef(false)
  const [busy, setBusy] = useState(false)
  const [decision, setDecision] = useState<ApprovalPart["decision"] | null>(null)
  const [decidedAt, setDecidedAt] = useState<number>()
  const [standingGranted, setStandingGranted] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = part.decision === "pending" ? (decision ?? part.decision) : part.decision
  const permanent = status === "approved" && (part.standing || standingGranted)
  const presentation = toolPresentation(tool, part)
  const capabilityRequest =
    part.scope?.server === "touri" && part.scope.tool.split("__").at(-1) === "capability_request"
  const allowStanding = part.allowStanding && !capabilityRequest
  const toolName = presentation.name
  const scopeHelp = `Toda a ferramenta ${toolName} poderá agir neste bot sem pedir novamente. Permite novas chamadas de ${toolName} neste bot sem pedir aprovação, inclusive com outros parâmetros. Você pode revogar essa permissão.`
  const revoke = async () => {
    if (!api || busy || !part.scope || !part.botId) return
    setBusy(true)
    setError(null)
    try {
      const { grants } = await api.request("GET /bots/:id/grants", {}, { id: part.botId })
      const grant = grants.find(
        (grant) =>
          grant.scope.source === part.scope?.source &&
          grant.scope.server === part.scope?.server &&
          grant.scope.tool === part.scope?.tool,
      )
      if (grant) await api.request("DELETE /bots/:id/grants/:grant", {}, { id: grant.botId, grant: grant.id })
      setRevoked(true)
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      setBusy(false)
    }
  }
  const answer = async (approved: boolean, standing = false) => {
    if (answering.current || !api || status !== "pending" || (approved && !presentation.canApprove)) return
    answering.current = true
    setBusy(true)
    setError(null)
    try {
      await api.request(
        "POST /approvals/:id",
        { decision: approved ? "approved" : "denied", standing },
        { id: part.approvalId },
      )
      setDecision(approved ? "approved" : "denied")
      setStandingGranted(approved && standing)
      const timestamp = Date.now()
      setDecidedAt(timestamp)
      onResolved?.(timestamp, approved ? "approved" : "denied")
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      setBusy(false)
      answering.current = false
    }
  }
  return (
    <ToolCallCard
      api={api}
      part={tool}
      approval={{ ...part, decision: status, standing: !!permanent }}
      finished={finished}
      createdAt={part.createdAt ?? createdAt}
      decidedAt={part.resolvedAt ?? resolvedAt ?? decidedAt}
      busy={busy}
      error={error}
      onKeyDown={(event) => {
        // Preserve native Enter behavior for denial and disclosures, but never let it
        // activate an approval button (including the standing grant).
        if (
          status === "pending" &&
          (event.key === "Enter" || event.key === " ") &&
          (event.target === event.currentTarget ||
            (event.target instanceof Element && event.target.closest(".tool-action-primary, .tool-standing-action")))
        ) {
          event.preventDefault()
          return
        }
        if (
          status !== "pending" ||
          event.repeat ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return
        // Only Escape (deny) is a card shortcut. Approving must be an explicit button press:
        // the card can receive focus programmatically, and a stray Enter must never approve.
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          void answer(false)
        }
      }}
      actions={
        status === "pending" ? (
          <div className="tool-approval-footer">
            <div className="tool-approval-actions">
              <button
                className="tool-action tool-action-primary"
                type="button"
                disabled={busy || !api || !presentation.canApprove}
                onClick={() => void answer(true)}
              >
                {busy ? "Enviando…" : (presentation.approvalLabel ?? "Aprovar")}
              </button>
              {allowStanding && (
                <span className="tool-standing-action">
                  <button
                    className="tool-action tool-action-secondary"
                    type="button"
                    aria-describedby={tooltipId}
                    disabled={busy || !api || !presentation.canApprove}
                    onClick={() => void answer(true, true)}
                  >
                    Sempre neste bot
                  </button>
                  <span className="tool-standing-tooltip" role="tooltip" id={tooltipId}>
                    {scopeHelp}
                  </span>
                </span>
              )}
              <button
                className="tool-action tool-action-deny"
                type="button"
                disabled={busy || !api}
                onClick={() => void answer(false)}
              >
                {capabilityRequest ? t("Agora não") : "Negar"}
              </button>
            </div>
            {allowStanding && <p className="tool-standing-help">{scopeHelp}</p>}
            <span className="tool-shortcuts">
              Com o cartão em foco: <kbd>Esc</kbd> nega
            </span>
          </div>
        ) : permanent ? (
          <div className="tool-standing-resolution">
            <p>{revoked ? "Permissão permanente revogada." : scopeHelp}</p>
            <div className="tool-revoke-action">
              <button
                type="button"
                className="tool-action tool-action-deny"
                disabled={busy || !api || revoked}
                onClick={() => void revoke()}
              >
                Revogar
              </button>
            </div>
          </div>
        ) : null
      }
    />
  )
}
