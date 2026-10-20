import type { ApprovalPart } from "@touri/contracts"
import { useRef, useState } from "react"
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
  const answering = useRef(false)
  const [busy, setBusy] = useState(false)
  const [decision, setDecision] = useState<ApprovalPart["decision"] | null>(null)
  const [decidedAt, setDecidedAt] = useState<number>()
  const [standingGranted, setStandingGranted] = useState(false)
  const [confirmStanding, setConfirmStanding] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = part.decision === "pending" ? (decision ?? part.decision) : part.decision
  const permanent = status === "approved" && (part.standing || standingGranted)
  const presentation = toolPresentation(tool, part)
  const capabilityRequest =
    part.scope?.server === "touri" && part.scope.tool.split("__").at(-1) === "capability_request"
  const allowStanding = part.allowStanding && !capabilityRequest
  const toolName = presentation.name
  const scopeHelp = t(
    "A ferramenta {name} poderá agir neste bot sem pedir aprovação novamente, inclusive em novas chamadas com outros parâmetros. Você pode remover essa permissão em Avançado → Permissões.",
    { name: toolName },
  )
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
        // Keep accidental Enter and Space presses from approving a focused card.
        if (
          status === "pending" &&
          (event.key === "Enter" || event.key === " ") &&
          (event.target === event.currentTarget ||
            (event.target instanceof Element &&
              event.target.closest(".tool-action-approve, .tool-standing-action, .tool-standing-confirm")))
        ) {
          event.preventDefault()
        }
      }}
      actions={
        status === "pending" ? (
          <div className="tool-approval-footer">
            <div className="tool-approval-actions">
              <button
                className="tool-action tool-action-primary tool-action-approve"
                type="button"
                disabled={busy || !api || !presentation.canApprove}
                onClick={() => void answer(true)}
              >
                {busy ? t("Enviando…") : (presentation.approvalLabel ?? t("Approve"))}
              </button>
              <button
                className="tool-action tool-action-deny"
                type="button"
                disabled={busy || !api}
                onClick={() => void answer(false)}
              >
                {capabilityRequest ? t("Agora não") : t("Deny")}
              </button>
            </div>
            {allowStanding && (
              <div className="tool-standing-section">
                {!confirmStanding ? (
                  <button
                    className="tool-standing-action text-button"
                    type="button"
                    disabled={busy || !api || !presentation.canApprove}
                    onClick={() => setConfirmStanding(true)}
                  >
                    {t("Permitir sempre nesta ferramenta")}
                  </button>
                ) : (
                  <fieldset className="tool-standing-confirmation">
                    <legend className="visually-hidden">
                      {t("Permissão permanente para {name}", { name: toolName })}
                    </legend>
                    <p>{scopeHelp}</p>
                    <div className="tool-approval-actions">
                      <button
                        className="tool-action tool-action-primary tool-standing-confirm"
                        type="button"
                        disabled={busy || !api || !presentation.canApprove}
                        onClick={() => void answer(true, true)}
                      >
                        {t("Sim, permitir {name} neste bot sem perguntar de novo", { name: toolName })}
                      </button>
                      <button
                        className="tool-action tool-action-secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmStanding(false)}
                      >
                        {t("Back")}
                      </button>
                    </div>
                  </fieldset>
                )}
              </div>
            )}
          </div>
        ) : permanent ? (
          <div className="tool-standing-resolution">
            <p>{revoked ? t("Permissão permanente revogada.") : scopeHelp}</p>
            <div className="tool-revoke-action">
              <button
                type="button"
                className="tool-action tool-action-deny"
                disabled={busy || !api || revoked}
                onClick={() => void revoke()}
              >
                {t("Revoke")}
              </button>
            </div>
          </div>
        ) : null
      }
    />
  )
}
