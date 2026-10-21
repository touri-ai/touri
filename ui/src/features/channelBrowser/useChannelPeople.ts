import type { ChannelPerson } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"

export const useChannelPeople = (api: UiApi | null | undefined, groupId: string | null) => {
  const [roster, setRoster] = useState<{ api: UiApi; groupId: string; people: ChannelPerson[] } | null>(null)

  useEffect(() => {
    if (!api || !groupId) return
    let active = true
    let pending = false
    const refresh = async (): Promise<void> => {
      if (!active || pending) return
      pending = true
      try {
        const { people } = await api.request("GET /groups/:id/people", {}, { id: groupId })
        if (active) setRoster({ api, groupId, people: Array.isArray(people) ? people : [] })
      } catch {
        if (active) setRoster(null)
      } finally {
        pending = false
      }
    }
    const onFocus = (): void => {
      void refresh()
    }
    const unsubscribe = api.subscribeConnection?.((connected) => {
      if (connected) void refresh()
    })
    window.addEventListener("focus", onFocus)
    void refresh()

    return () => {
      active = false
      unsubscribe?.()
      window.removeEventListener("focus", onFocus)
    }
  }, [api, groupId])

  if (!roster || roster.api !== api || roster.groupId !== groupId) return []

  return roster.people
}
