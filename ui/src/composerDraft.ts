import { type SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react"

const keyFor = (threadId: string) => `touri.composer-draft.v1:${threadId}`
const read = (threadId: string | undefined) => {
  try {
    return { threadId, text: threadId ? (localStorage.getItem(keyFor(threadId)) ?? "") : "", failed: false }
  } catch {
    return { threadId, text: "", failed: true }
  }
}

/** Save on every edit, before quitting can discard the UI. Each conversation owns its draft. */
export const useComposerDraft = (threadId: string | undefined) => {
  const [state, setState] = useState(() => read(threadId))
  const current = useRef(state)
  const selected = useRef(threadId)
  selected.current = threadId
  useLayoutEffect(() => {
    const next = read(threadId)
    current.current = next
    setState(next)
  }, [threadId])
  const setDraft = useCallback(
    (update: SetStateAction<string>) => {
      const previous = current.current.threadId === threadId ? current.current : read(threadId)
      const text = typeof update === "function" ? update(previous.text) : update
      let failed = false
      try {
        if (threadId) {
          if (text) localStorage.setItem(keyFor(threadId), text)
          else localStorage.removeItem(keyFor(threadId))
        }
      } catch {
        failed = true
      }
      // A late send in an old conversation may clear its own draft, never the selected one.
      if (selected.current !== threadId) return
      const next = { threadId, text, failed }
      current.current = next
      setState(next)
    },
    [threadId],
  )
  return { draft: state.threadId === threadId ? state.text : "", setDraft, draftSaveFailed: state.failed }
}
