import { useState } from "react"
import { createApiClient, createTauriInvoke, resolveSidecarEndpoint, type UiApi, webEndpoint } from "../../api/client"
import { Modal } from "../../components/Modal"
import { t } from "../../i18n"
import { ReportProblem } from "./ReportProblem"

export const problemErrorCode = (message: string, fallback = "TOURI-E1000") =>
  message.match(/TOURI-E\d{4}/)?.[0] ?? fallback
export const ReportErrorButton = ({
  api,
  message,
  fallbackCode,
  offline = false,
}: {
  api?: UiApi | undefined
  message: string
  fallbackCode?: string
  offline?: boolean
}) => {
  const [open, setOpen] = useState(false)
  const [resolved, setResolved] = useState<UiApi | undefined>(api)
  const [resolving, setResolving] = useState(false)
  const show = async () => {
    setResolving(true)
    if (!api && !offline) {
      try {
        const endpoint =
          "__TAURI_INTERNALS__" in window
            ? await resolveSidecarEndpoint(createTauriInvoke())
            : webEndpoint(window.location)
        const client = createApiClient({ endpoint })
        await client.request("GET /health", {})
        setResolved(client)
      } catch {
        setResolved(undefined)
      }
    }
    setResolving(false)
    setOpen(true)
  }
  return (
    <>
      <button className="button button-quiet" type="button" disabled={resolving} onClick={() => void show()}>
        {t(resolving ? "Preparing report…" : "Report this problem")}
      </button>
      {open && (
        <Modal title={t("Report a problem")} className="settings-modal" onClose={() => setOpen(false)}>
          <div className="report-dialog-content">
            <ReportProblem
              api={offline ? undefined : resolved}
              errorCode={problemErrorCode(message, fallbackCode)}
              errorMessage={message}
              offline={offline || !resolved}
            />
          </div>
        </Modal>
      )}
    </>
  )
}
