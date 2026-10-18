import { useEffect, useRef, useState } from "react"

export const useStreamingContent = (content: string, streaming: boolean): string => {
  const [displayed, setDisplayed] = useState(content)
  const latest = useRef(content)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep only the latest text between paints; never queue token snapshots.
  useEffect(() => {
    latest.current = content
    if (!streaming) {
      if (pending.current !== null) clearTimeout(pending.current)
      pending.current = null
      setDisplayed(content)
      return
    }
    if (pending.current !== null) return

    pending.current = setTimeout(() => {
      pending.current = null
      setDisplayed(latest.current)
    }, 100)
  }, [content, streaming])
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current)
    },
    [],
  )

  return streaming ? displayed : content
}
