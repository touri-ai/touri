import type { HostKind } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "./api/client"
import { useServerMode } from "./features/server/serverMode"

/** Host identity comes from the sidecar, never from the browser's OS. */
export const useHost = (api?: UiApi | null): HostKind => {
  const { status } = useServerMode()
  const [snapshot, setSnapshot] = useState<{ api: UiApi; host: HostKind } | null>(null)
  useEffect(() => {
    let active = true
    if (api)
      void api
        .request("GET /health", {})
        .then((health) => {
          if (active && health.host) setSnapshot({ api, host: health.host })
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [api])
  if (status?.mode === "server") return "server"
  if (snapshot?.api !== api) return "computer"

  return snapshot?.host ?? "computer"
}
