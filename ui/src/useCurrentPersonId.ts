import { useEffect, useState } from "react"
import type { UiApi } from "./api/client"
import { ApiError } from "./errors"

type CurrentPerson = { id: string; role: "member" | "admin" }

export const useCurrentPerson = (api: UiApi | null, isLocalOwner: boolean): CurrentPerson | null => {
  const [session, setSession] = useState<{ api: UiApi; person: CurrentPerson } | null>(null)
  const isOwner = isLocalOwner || api?.isMock

  useEffect(() => {
    if (!api || isOwner) return

    let active = true
    let pending = false
    let retryDelay = 2000
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const refreshIdentity = async (): Promise<void> => {
      if (!active || pending) return

      clearTimeout(retryTimer)
      pending = true
      try {
        const { person } = await api.request("GET /session", {})
        if (!active) return

        setSession({ api, person: { id: person.id, role: person.role } })
        retryDelay = 2000
      } catch (error) {
        if (!active || (error instanceof ApiError && [401, 403, 404].includes(error.status))) return

        retryTimer = setTimeout(() => void refreshIdentity(), retryDelay)
        retryDelay = Math.min(retryDelay * 2, 30_000)
      } finally {
        pending = false
      }
    }
    const refreshOnline = (): void => {
      void refreshIdentity()
    }
    const unsubscribe = api.subscribeConnection?.((connected) => {
      if (connected) refreshOnline()
    })
    window.addEventListener("online", refreshOnline)
    void refreshIdentity()

    return () => {
      active = false
      clearTimeout(retryTimer)
      unsubscribe?.()
      window.removeEventListener("online", refreshOnline)
    }
  }, [api, isOwner])

  if (isOwner) return { id: "owner", role: "admin" }

  return session?.api === api ? session.person : null
}

export const useCurrentPersonId = (api: UiApi | null, isLocalOwner: boolean): string | null =>
  useCurrentPerson(api, isLocalOwner)?.id ?? null
