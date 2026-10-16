import type { MachineState } from "@touri/contracts"
import { useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { ErrorText } from "./ErrorDetails"

export const MachineStatus = ({
  machine,
  turnFailed,
  api,
}: {
  machine: MachineState
  turnFailed: boolean
  api: UiApi
}) => {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const independent =
    machine.status === "starting" && turnFailed && machine.progress !== "Iniciando serviço de máquinas…"
  const explanation = t("Still preparing its computer…")
  const stop = async () => {
    if (stopping) return
    setStopping(true)
    setError(null)
    try {
      await api.request("POST /bots/:id/machine/stop", {}, { id: machine.botId })
    } catch (failure) {
      setError(userFacingError(failure))
    } finally {
      setStopping(false)
    }
  }
  return (
    <div className="machine-turn-status" role="status" aria-live="polite">
      <span className={`machine-chip machine-${machine.status}`}>
        {machine.status === "starting"
          ? independent
            ? explanation
            : t("Preparing the computer…")
          : machine.status === "running"
            ? t("Working on its computer…")
            : t("Waiting for its computer…")}
      </span>
      {independent && (
        <button type="button" className="button button-quiet" disabled={stopping} onClick={() => void stop()}>
          {stopping ? t("Stopping computer…") : t("Stop computer")}
        </button>
      )}
      {error && (
        <div role="alert">
          <ErrorText text={error} />
        </div>
      )}
    </div>
  )
}
