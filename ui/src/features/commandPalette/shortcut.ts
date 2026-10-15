type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">

export const isMacPlatform = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

/** ⌘K on macOS, Ctrl+K elsewhere. A bare "k" (typing in the composer) never matches. */
export const isPaletteShortcut = (event: ShortcutEvent): boolean => {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return false
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey
}

/** ⌘N on macOS, Ctrl+N elsewhere: opens the new bot dialog. */
export const isNewBotShortcut = (event: ShortcutEvent): boolean => {
  if (event.key.toLowerCase() !== "n" || event.altKey || event.shiftKey) return false
  return isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey || event.metaKey
}

export const paletteShortcutLabel = (): string => (isMacPlatform() ? "⌘K" : "Ctrl K")
