import { listen } from "@tauri-apps/api/event"
import { useEffect, useState } from "react"
import { createApiClient, createTauriInvoke, resolveSidecarEndpoint, type UiApi } from "../../api/client"
import { Modal } from "../../components/Modal"
import { ReportProblem } from "./ReportProblem"

/** Lives outside the app boundary so Help remains useful after a fatal render or startup failure. */
export const ReportMenuLauncher = ({ api }: { api?: UiApi | undefined }) => {
  const [open, setOpen] = useState(false)
  const [resolved, setResolved] = useState<UiApi | undefined>(api)
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return
    let active = true
    let stop: (() => void) | undefined
    void listen("report-problem", async () => {
      let client = api
      if (!client) {
        try {
          client = createApiClient({ endpoint: await resolveSidecarEndpoint(createTauriInvoke()) })
          await client.request("GET /health", {})
        } catch {
          client = undefined
        }
      }
      if (active) {
        setResolved(client)
        setOpen(true)
      }
    })
      .then((unlisten) => {
        if (active) stop = unlisten
        else unlisten()
      })
      .catch(() => undefined)
    return () => {
      active = false
      stop?.()
    }
  }, [api])
  return open ? (
    <Modal title="Reportar problema" className="settings-modal" onClose={() => setOpen(false)}>
      <div className="report-dialog-content">
        <ReportProblem api={resolved} offline={!resolved} />
      </div>
    </Modal>
  ) : null
}
