import { useEffect, useRef, useState } from "react"

export const useStreamingContent = (content: string, streaming: boolean): string => {
  const [displayed, setDisplayed] = useState(content)
  const latest = useRef(content)
  const waitingForText = useRef(true)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frame = useRef<number | null>(null)

  // Keep only the latest text between paints; never queue token snapshots.
  useEffect(() => {
    latest.current = content
    // The first word has no earlier paint to coalesce with; show it without the cadence delay.
    if (!streaming || (waitingForText.current && content.trim().length > 0)) {
      waitingForText.current = content.trim().length === 0
      if (pending.current !== null) clearTimeout(pending.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      pending.current = null
      frame.current = null
      setDisplayed(content)
      return
    }
    if (pending.current !== null || frame.current !== null) return

    pending.current = setTimeout(() => {
      pending.current = null
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        setDisplayed(latest.current)
      })
    }, 100)
  }, [content, streaming])
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      pending.current = null
      frame.current = null
    },
    [],
  )

  return streaming ? displayed : content
}
