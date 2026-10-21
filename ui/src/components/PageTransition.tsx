import { type CSSProperties, type ReactNode, type RefCallback, useLayoutEffect, useRef } from "react"
import { isMotionReduced, observeMotionPreference } from "../design/motionPreference"
import { motionTiers, springEasing } from "../design/spring"
import type { AppRoute } from "../workspaceState"
import { ScreenHeaderContext } from "./ScreenHeaderContext"

const depth = (route: AppRoute): number =>
  route.section === "bots"
    ? route.screen === "chat"
      ? 0
      : 1
    : route.page === "cron"
      ? 1
      : route.page === "integracoes"
        ? 2
        : 3
export const pageDirection = (from: AppRoute, to: AppRoute): number => (depth(to) < depth(from) ? -1 : 1)
export const pageKey = (route: AppRoute): string => (route.section === "bots" ? route.screen : route.page)

export const PageTransition = ({
  route,
  children,
  onHeaderChange,
}: {
  route: AppRoute
  children: ReactNode
  onHeaderChange?: RefCallback<HTMLElement>
}) => {
  const key = pageKey(route)
  const nextDepth = depth(route)
  const previous = useRef({ key, depth: nextDepth })
  const lastDirection = useRef(1)
  const ref = useRef<HTMLDivElement>(null)
  const direction = previous.current.key === key ? lastDirection.current : nextDepth < previous.current.depth ? -1 : 1
  useLayoutEffect(() => {
    const element = ref.current
    const changed = previous.current.key !== key
    previous.current = { key, depth: nextDepth }
    lastDirection.current = direction
    if (element && changed) {
      // Focus the new destination even when motion is disabled or snapshots own the animation.
      const active = document.activeElement
      const approvalDestination =
        active instanceof HTMLElement && element.contains(active) && active.closest("[data-approval-id]")
      if (!approvalDestination) {
        const destination = element.querySelector<HTMLElement>("h1, h2, [role=heading]") ?? element
        if (!destination.hasAttribute("tabindex")) destination.tabIndex = -1
        destination.focus({ preventScroll: true })
      }
    }
    if (
      !element ||
      !changed ||
      isMotionReduced() ||
      !element.animate ||
      document.documentElement.dataset.pageTransition === "active"
    )
      return
    const animation = element.animate(
      [
        { opacity: 0, transform: "translateX(calc(var(--inline-sign) * var(--page-step) * 24px))" },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: motionTiers.surface.duration, easing: springEasing(motionTiers.surface) },
    )
    const stop = observeMotionPreference(() => {
      if (isMotionReduced()) animation.cancel()
    })
    return () => {
      animation.cancel()
      stop()
    }
  }, [key, nextDepth, direction])
  return (
    <ScreenHeaderContext.Provider value={onHeaderChange}>
      <div
        ref={ref}
        className="workspace-page"
        data-page={key}
        data-navigation={direction === -1 ? "pop" : "push"}
        style={{ "--page-step": direction } as CSSProperties}
      >
        {children}
      </div>
    </ScreenHeaderContext.Provider>
  )
}
