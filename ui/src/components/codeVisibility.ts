type VisibilityEntry = Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">
type CodeObserver = Pick<IntersectionObserver, "observe" | "disconnect">
export type CodeObserverFactory = (receive: (entries: readonly VisibilityEntry[]) => void) => CodeObserver | null

export const observeCodeVisibility = (
  element: Element | null,
  show: () => void,
  createObserver: CodeObserverFactory = createCodeObserver,
): (() => void) => {
  if (!element) {
    show()
    return () => undefined
  }

  // A callback may already be queued when its message leaves the transcript.
  let active = true
  const observer = createObserver((entries) => {
    if (!active || !entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) return
    active = false
    observer?.disconnect()
    show()
  })
  if (!observer) {
    show()
    return () => undefined
  }

  observer.observe(element)
  return () => {
    active = false
    observer.disconnect()
  }
}

const createCodeObserver: CodeObserverFactory = (receive) => {
  if (typeof IntersectionObserver === "undefined") return null

  // Opening content must cross a threshold after an edge-only intersection.
  return new IntersectionObserver(receive, { rootMargin: "160px", threshold: Number.EPSILON })
}
