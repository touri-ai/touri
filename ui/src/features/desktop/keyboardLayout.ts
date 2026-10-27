import { useSyncExternalStore } from "react"

export type KeyboardLayout = "br" | "us"
const change = "touri:computer-keyboard-layout"

export const getDefaultKeyboardLayout = (languages: readonly string[]): KeyboardLayout =>
  languages.some((language) => /^pt(?:-|$)/i.test(language)) ? "br" : "us"

export const getKeyboardLayout = (botId: string): KeyboardLayout => {
  try {
    const saved = localStorage.getItem(getKey(botId))
    if (saved === "br" || saved === "us") return saved
  } catch {
    // Private windows can deny storage; the system language still provides a default.
  }

  return getDefaultKeyboardLayout(navigator.languages)
}

export const saveKeyboardLayout = (botId: string, layout: KeyboardLayout) => {
  try {
    localStorage.setItem(getKey(botId), layout)
  } catch {
    // Typing remains available when preferences cannot be persisted.
  }
  window.dispatchEvent(new Event(change))
}

export const useKeyboardLayout = (botId: string) =>
  useSyncExternalStore(
    subscribe,
    () => getKeyboardLayout(botId),
    () => "us" as const,
  )

const getKey = (botId: string) => `touri.computer-keyboard:${botId}`
const subscribe = (listener: () => void) => {
  window.addEventListener(change, listener)
  window.addEventListener("storage", listener)

  return () => {
    window.removeEventListener(change, listener)
    window.removeEventListener("storage", listener)
  }
}
