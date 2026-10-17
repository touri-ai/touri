import { useId, useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { ErrorText } from "./ErrorDetails"

export const MachineStopButton = ({
  api,
  botId,
  activeTurns = false,
  onStopped,
}: {
  api: UiApi
  botId: string
  activeTurns?: boolean
  onStopped?: () => void
}) => {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonId = useId()
  const reason = activeTurns
    ? t("Aguarde o turno terminar ou pare o turno para parar a máquina.")
    : t("Para a máquina e mantém seus dados.")
  const stop = async () => {
    if (stopping || activeTurns) return
    setStopping(true)
    setError(null)
    try {
      await api.request("POST /bots/:id/machine/stop", {}, { id: botId })
      onStopped?.()
    } catch (failure) {
      setError(userFacingError(failure))
    } finally {
      setStopping(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="button button-quiet"
        disabled={stopping || activeTurns}
        title={reason}
        aria-describedby={reasonId}
        onClick={() => void stop()}
      >
        {stopping ? t("Stopping computer…") : t("Stop computer")}
      </button>
      <span id={reasonId} className={activeTurns ? "machine-progress" : "visually-hidden"}>
        {reason}
      </span>
      {error && (
        <div role="alert">
          <ErrorText text={error} />
        </div>
      )}
    </>
  )
}
