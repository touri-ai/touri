import { useSyncExternalStore } from "react"

export const usePhoneViewport = () => useSyncExternalStore(subscribeToPhoneViewport, isPhoneViewport, () => false)

const query = "(max-width: 620px)"

const subscribeToPhoneViewport = (changed: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener("change", changed)
  return () => media.removeEventListener("change", changed)
}

const isPhoneViewport = () => window.matchMedia(query).matches
