import { useEffect, useState } from "react"
import { isMotionReduced, observeMotionPreference } from "../design/motionPreference"

export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(isMotionReduced)
  useEffect(() => {
    const change = (): void => setReduced(isMotionReduced())
    const stop = observeMotionPreference(change)
    change()
    return stop
  }, [])
  return reduced
}
