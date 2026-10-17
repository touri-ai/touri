import { useEffect, useRef, useState } from "react"
import { buildWebDeepLink, type DeepLink, parseDeepLink } from "./deepLink"
import { type AppRoute, migrateRoute } from "./workspaceState"

const historyRoute = (location: DeepLink): AppRoute | undefined => {
  const entry = window.history.state?.touriNavigation
  return entry?.bot === location.bot && entry?.thread === location.thread ? migrateRoute(entry.route) : undefined
}

const requestedLocation = () => {
  const location = parseDeepLink(window.location.href)
  return location ? { location, route: historyRoute(location) } : null
}

/** Browser history follows selected conversations; desktop navigation stays in the native shell. */
export const useWebNavigation = ({
  enabled,
  ready,
  bot,
  thread,
  route,
  restore,
  exists,
}: DeepLink & {
  enabled: boolean
  ready: boolean
  route: AppRoute
  restore: (location: DeepLink, route?: AppRoute) => void
  exists: (location: DeepLink) => boolean
}): void => {
  const [pending, setPending] = useState(() => (enabled ? requestedLocation() : null))
  const mode = useRef<"replaceState" | "pushState">("replaceState")
  const previous = useRef<DeepLink | null>(null)

  useEffect(() => {
    if (!enabled) return
    const pop = (): void => {
      // Restoration must not append an entry or discard the browser's forward stack.
      mode.current = "replaceState"
      setPending(requestedLocation() ?? { location: { bot: null, thread: null }, route: undefined })
    }
    window.addEventListener("popstate", pop)
    return () => window.removeEventListener("popstate", pop)
  }, [enabled])

  useEffect(() => {
    if (!enabled || !ready) return
    if (pending) {
      mode.current = "replaceState"
      restore(pending.location, pending.route)
      setPending(null)
      return
    }
    const next = buildWebDeepLink({ bot, thread }, window.location.href)
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    // A deleted destination falls back in place rather than adding an unusable Back step.
    const method = previous.current && !exists(previous.current) ? "replaceState" : mode.current
    const savedRoute = historyRoute({ bot, thread })
    // Panels/global screens update the current entry, so reloading preserves the existing workspace behavior.
    if (next !== current || JSON.stringify(savedRoute) !== JSON.stringify(route))
      window.history[next === current ? "replaceState" : method](
        { ...window.history.state, touriNavigation: { bot, thread, route } },
        "",
        next,
      )
    previous.current = { bot, thread }
    mode.current = "pushState"
  }, [enabled, ready, bot, thread, route, pending, restore, exists])
}
