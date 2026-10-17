import { type SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react"
import { getStorageScope, scopedStorageKey } from "./storageScope"

const keyFor = (threadId: string, scope: string | null) =>
  scopedStorageKey(`touri.composer-draft.v1:${threadId}`, scope)
const read = (threadId: string | undefined, scope: string | null) => {
  try {
    return {
      threadId,
      scope,
      text: threadId ? (localStorage.getItem(keyFor(threadId, scope)) ?? "") : "",
      failed: false,
    }
  } catch {
    return { threadId, scope, text: "", failed: true }
  }
}

/** Save on every edit, before quitting can discard the UI. Each conversation owns its draft. */
export const useComposerDraft = (threadId: string | undefined) => {
  const scope = getStorageScope()
  const [state, setState] = useState(() => read(threadId, scope))
  const current = useRef(state)
  const mounted = useRef(false)
  const selected = useRef({ threadId, scope })
  selected.current = { threadId, scope }
  useLayoutEffect(() => {
    mounted.current = true
    const next = read(threadId, scope)
    current.current = next
    setState(next)
    return () => {
      mounted.current = false
    }
  }, [threadId, scope])
  const setDraft = useCallback(
    (update: SetStateAction<string>) => {
      const previous =
        mounted.current && current.current.threadId === threadId && current.current.scope === scope
          ? current.current
          : read(threadId, scope)
      const text = typeof update === "function" ? update(previous.text) : update
      let failed = false
      try {
        if (threadId) {
          if (text) localStorage.setItem(keyFor(threadId, scope), text)
          else localStorage.removeItem(keyFor(threadId, scope))
        }
      } catch {
        failed = true
      }
      // A late send in an old conversation may clear its own draft, never the selected one.
      if (!mounted.current || selected.current.threadId !== threadId || selected.current.scope !== scope) return
      const next = { threadId, scope, text, failed }
      current.current = next
      setState(next)
    },
    [threadId, scope],
  )
  return {
    draft: state.threadId === threadId && state.scope === scope ? state.text : "",
    setDraft,
    draftSaveFailed: state.failed,
  }
}
