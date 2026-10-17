import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react"
import { isMotionReduced, observeMotionPreference } from "../design/motionPreference"
import { motionTiers } from "../design/spring"
import { ModalLayer } from "./Modal"
import { useReveal } from "./Reveal"

/** Retain a surface for its exit only. Closed content becomes inert immediately. */
export const MotionPresence = ({
  show,
  kind,
  children,
}: {
  show: boolean
  kind: "modal" | "panel" | "popover" | "toast"
  children: ReactNode
}) => {
  const [mounted, setMounted] = useState(show)
  const retained = useRef(children)
  const ref = useReveal<HTMLDivElement>(show)
  useLayoutEffect(() => {
    if (show) retained.current = children
  }, [show, children])
  useLayoutEffect(() => {
    if (show) {
      setMounted(true)
      return
    }
    if (isMotionReduced()) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), motionTiers.quick.duration)
    const stop = observeMotionPreference(() => {
      if (isMotionReduced()) setMounted(false)
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [show])
  if (!mounted && !show) return null
  const surface = (
    <div
      ref={ref}
      className={`motion-presence motion-${kind}`}
      data-motion-state={show ? "open" : "closed"}
      inert={!show}
      aria-hidden={!show || undefined}
    >
      {show ? children : retained.current}
    </div>
  )
  return kind === "modal" ? <ModalLayer>{surface}</ModalLayer> : surface
}

/** IDs, never message text, trigger insertion. Initial history and scope changes stay still. */
export const useInsertedIds = (ids: string[], scope = "") => {
  const signature = JSON.stringify(ids)
  const known = useRef({ scope, ids: new Set(ids) })
  const [inserted, setInserted] = useState<ReadonlySet<string>>(new Set())
  useLayoutEffect(() => {
    const current = JSON.parse(signature) as string[]
    const added = current.filter((id) => !known.current.ids.has(id))
    const sameScope = known.current.scope === scope
    known.current = { scope, ids: new Set(current) }
    setInserted(new Set(sameScope && !isMotionReduced() ? added : []))
    if (!added.length) return
    const timer = window.setTimeout(() => setInserted(new Set()), motionTiers.surface.duration)
    return () => window.clearTimeout(timer)
  }, [signature, scope])
  return inserted
}

/** Slide one measured indicator; keep the existing tab semantics and keyboard handling. */
export const useSegmentedControl = (ref: RefObject<HTMLDivElement | null>, value: string) => {
  // biome-ignore lint/correctness/useExhaustiveDependencies: selection changes the measured DOM button
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const active = element.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!active) return
      element.style.setProperty("--segment-x", `${active.offsetLeft}px`)
      element.style.setProperty("--segment-y", `${active.offsetTop}px`)
      element.style.setProperty("--segment-width", `${active.offsetWidth}px`)
      element.style.setProperty("--segment-height", `${active.offsetHeight}px`)
    }
    measure()
    const frame = requestAnimationFrame(() => {
      element.dataset.motionReady = "true"
    })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [ref, value])
}

/** Pair with a localized role=status label; decorative bars are hidden from accessibility. */
export const MotionSkeleton = ({ lines = 3 }: { lines?: number }) => (
  <div className="motion-skeleton" aria-hidden="true">
    {Array.from({ length: lines }, (_, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: immutable decorative bars
      <span key={index} />
    ))}
  </div>
)
