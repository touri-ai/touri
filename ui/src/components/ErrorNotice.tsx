import { useContext, useRef, useState } from "react"
import { type ErrorRecovery, errorRecovery, type RecoveryAction, type RecoveryContext } from "../errorRecovery"
import { ErrorDetails } from "./ErrorDetails"
import { FailureActionContext } from "./FailureActionContext"
import "./ErrorNotice.css"

/** Shared short copy, explicit recovery and closed diagnostics for every error surface. */
export const ErrorNotice = ({
  error,
  context,
  recovery,
  onAction,
  showActions = true,
}: {
  error?: unknown
  context?: RecoveryContext | undefined
  recovery?: ErrorRecovery | undefined
  onAction?: ((action: RecoveryAction) => void | Promise<void>) | undefined
  showActions?: boolean
}) => {
  const view = recovery ?? errorRecovery(error, context)
  const open = useContext(FailureActionContext)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const actionFailure = actionError === null ? null : errorRecovery(actionError)
  const act = async (kind: RecoveryAction) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setActionError(null)
    try {
      if (onAction) await onAction(kind)
      else
        open(
          kind === "login" ? { kind: "setting", settingId: "providerLogin", label: "" } : { kind: "doctor", label: "" },
        )
    } catch (reason) {
      setActionError(reason)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return (
    <div className="error-notice">
      <p>{view.message}</p>
      {showActions && (
        <div className="error-recovery-actions">
          {view.actions.map((action) => (
            <button
              key={action.kind}
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void act(action.kind)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {view.diagnostic && <ErrorDetails code={view.diagnostic} />}
      {actionFailure && (
        <div role="alert">
          <p>{actionFailure.message}</p>
          <ErrorDetails code={actionFailure.diagnostic} />
        </div>
      )}
    </div>
  )
}
