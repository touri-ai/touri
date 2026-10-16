import { useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { ErrorText } from "./ErrorDetails"

export const MachineServiceButton = ({
  api,
  botId,
  onStarted,
}: {
  api: UiApi
  botId?: string
  onStarted?: () => Promise<void>
}) => {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      await api.request("POST /machines/service/start", botId ? { botId } : {})
      await onStarted?.()
    } catch (failure) {
      setError(userFacingError(failure))
    } finally {
      setStarting(false)
    }
  }
  return (
    <div className="machine-service-action">
      <button type="button" className="button button-quiet" disabled={starting} onClick={() => void start()}>
        {starting ? t("Starting computer service…") : t("Start computer service")}
      </button>
      {error && (
        <div role="alert">
          <ErrorText text={error} />
        </div>
      )}
    </div>
  )
}
