import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react"

type BrowserTakeoverAction = { label: string; run: () => void }

type BrowserActivityControls = {
  canTakeOver: boolean
  label: string
  registerTakeover: (action: BrowserTakeoverAction | null) => () => void
  requestTakeover: () => void
}

const BrowserActivityControlsContext = createContext<BrowserActivityControls>({
  canTakeOver: false,
  label: "",
  registerTakeover: () => () => {},
  requestTakeover: () => {},
})

export const BrowserActivityControlsProvider = ({ children }: { children: ReactNode }) => {
  const action = useRef<BrowserTakeoverAction | null>(null)
  const [label, setLabel] = useState("")
  const registerTakeover = useCallback((next: BrowserTakeoverAction | null) => {
    action.current = next
    setLabel(next?.label ?? "")

    return () => {
      if (action.current !== next) return
      action.current = null
      setLabel("")
    }
  }, [])
  const requestTakeover = useCallback(() => action.current?.run(), [])
  const value = useMemo(
    () => ({ canTakeOver: action.current !== null, label, registerTakeover, requestTakeover }),
    [label, registerTakeover, requestTakeover],
  )

  return <BrowserActivityControlsContext.Provider value={value}>{children}</BrowserActivityControlsContext.Provider>
}

export const useBrowserActivityControls = (): BrowserActivityControls => useContext(BrowserActivityControlsContext)
