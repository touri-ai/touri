import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react"

/** Position a portaled surface in viewport coordinates, outside scrolling/animated ancestors. */
export const useAnchoredPopover = (
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  { side = "bottom", align = "end", gap = 4 }: { side?: "top" | "bottom"; align?: "start" | "end"; gap?: number } = {},
) => {
  const surface = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const trigger = anchor.current
      const popover = surface.current
      if (!trigger || !popover) return
      const rect = trigger.getBoundingClientRect()
      const viewport = window.visualViewport
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8
      const topEdge = (viewport?.offsetTop ?? 0) + 8
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 16
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16
      // Layout dimensions exclude the surface's entrance animation scale/translation.
      const width = popover.offsetWidth
      const height = popover.offsetHeight
      const above = rect.top - gap - topEdge
      const below = bottomEdge - rect.bottom - gap
      const up = side === "top" ? above >= height || above > below : below < height && above > below
      const left = Math.max(leftEdge, Math.min(align === "end" ? rect.right - width : rect.left, rightEdge - width))
      const top = Math.max(topEdge, Math.min(up ? rect.top - height - gap : rect.bottom + gap, bottomEdge - height))
      setPosition((previous) => (previous.left === left && previous.top === top ? previous : { left, top }))
    }
    reposition()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition)
    if (anchor.current) observer?.observe(anchor.current)
    if (surface.current) observer?.observe(surface.current)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    window.visualViewport?.addEventListener("resize", reposition)
    window.visualViewport?.addEventListener("scroll", reposition)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
      window.visualViewport?.removeEventListener("resize", reposition)
      window.visualViewport?.removeEventListener("scroll", reposition)
    }
  }, [open, anchor, side, align, gap])

  const style: CSSProperties = {
    position: "fixed",
    zIndex: 100,
    ...position,
    right: "auto",
    bottom: "auto",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "calc(100dvh - 16px)",
    overflowY: "auto",
  }
  // Body portals are inert behind native modal drawers. Stay in their top layer, outside the list.
  const portalRoot = anchor.current?.closest("dialog[open]") ?? document.body
  return { surface, style, portalRoot }
}
