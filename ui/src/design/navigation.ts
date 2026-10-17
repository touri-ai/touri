import { flushSync } from "react-dom"
import { pageDirection, pageKey } from "../components/PageTransition"
import type { AppRoute } from "../workspaceState"
import { isMotionReduced, observeMotionPreference } from "./motionPreference"

let activeTransition: ViewTransition | undefined
let navigation = 0

/** Snapshot the outgoing page when available; the component provides a WebKit fallback. */
export const navigatePage = (
  from: AppRoute,
  to: AppRoute,
  commit: (route: AppRoute) => void,
  { immediate = false }: { immediate?: boolean } = {},
): void => {
  const current = ++navigation
  const root = document.documentElement
  activeTransition?.skipTransition()
  activeTransition = undefined
  delete root.dataset.pageTransition
  if (immediate || pageKey(from) === pageKey(to) || isMotionReduced() || !document.startViewTransition) {
    commit(to)
    return
  }
  root.style.setProperty("--page-step", String(pageDirection(from, to)))
  root.dataset.pageTransition = "active"
  const transition = document.startViewTransition(() => {
    if (navigation === current) flushSync(() => commit(to))
  })
  activeTransition = transition
  const stop = observeMotionPreference(() => {
    if (isMotionReduced()) transition.skipTransition()
  })
  // Skipping a pending snapshot rejects ready; navigation must still finish normally.
  void transition.ready.catch(() => undefined)
  void transition.finished
    .finally(() => {
      stop()
      if (activeTransition === transition) {
        delete root.dataset.pageTransition
        activeTransition = undefined
      }
    })
    .catch(() => undefined)
}
