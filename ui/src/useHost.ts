import { useEffect, useState } from "react"
import type { UiApi } from "./api/client"
import { useServerMode } from "./features/server/serverMode"

/** Host identity comes from the sidecar, never from the browser's OS. */
export const useHost = (api?: UiApi | null) => {
  const { status } = useServerMode()
  const [host, setHost] = useState<"mac" | "server">("__TAURI_INTERNALS__" in window ? "mac" : "server")
  useEffect(() => {
    let active = true
    if (api)
      void api
        .request("GET /health", {})
        .then((health) => {
          if (active && health.host) setHost(health.host)
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [api])
  return status?.mode === "server" ? "server" : host
}
