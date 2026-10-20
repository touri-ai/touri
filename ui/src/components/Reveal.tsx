import { type ReactNode, useLayoutEffect, useRef } from "react"
import { isMotionReduced, observeMotionPreference } from "../design/motionPreference"
import { Disclosure } from "./Disclosure"

/** Every reveal property derives from one interpolated scalar. */
export const useReveal = <T extends HTMLElement>(visible = true) => {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (isMotionReduced() || !visible) {
      element.style.setProperty("--reveal", visible ? "1" : "0")
      return
    }
    getComputedStyle(element).getPropertyValue("--reveal")
    const frame = requestAnimationFrame(() => element.style.setProperty("--reveal", "1"))
    const stop = observeMotionPreference(() => {
      if (isMotionReduced()) {
        cancelAnimationFrame(frame)
        element.style.setProperty("--reveal", visible ? "1" : "0")
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      stop()
    }
  }, [visible])
  return ref
}

/** Tool output shares the system Disclosure while keeping its measured reveal animation. */
export const RevealDetails = ({
  className,
  summary,
  children,
}: {
  className: string
  summary: ReactNode
  children: ReactNode
}) => {
  return (
    <Disclosure animateContent className={className} summary={summary}>
      {children}
    </Disclosure>
  )
}

export const AnimatedDisclosure = ({
  className,
  summary,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
}: {
  className?: string
  summary: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) => {
  return (
    <Disclosure
      animateContent
      className={`animated-disclosure ${className ?? ""}`}
      summary={summary}
      defaultOpen={defaultExpanded}
      {...(controlledExpanded !== undefined ? { open: controlledExpanded } : {})}
      {...(onExpandedChange ? { onOpenChange: onExpandedChange } : {})}
    >
      {children}
    </Disclosure>
  )
}
