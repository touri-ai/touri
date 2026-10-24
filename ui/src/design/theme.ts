export type ThemePreference = "dark" | "light" | "system"
const storageKey = "touri.appearance.v1"
const themeEvent = "touri:appearance"
// Without an explicit choice the app follows the operating system, including when storage fails.
let fallbackPreference: ThemePreference = "system"

export const readTheme = (): ThemePreference => {
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === "dark" || saved === "light" || saved === "system") return saved
  } catch {
    /* Embedded storage may be unavailable. */
    return fallbackPreference
  }
  return "system"
}

export const setTheme = (preference: ThemePreference): void => {
  fallbackPreference = preference
  try {
    localStorage.setItem(storageKey, preference)
  } catch {
    /* Apply even without storage. */
  }
  applyTheme(preference)
  window.dispatchEvent(new Event(themeEvent))
}

const applyTheme = (preference: ThemePreference): void => {
  document.documentElement.dataset.theme =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference
  document.documentElement.classList.toggle("dark", document.documentElement.dataset.theme === "dark")
}

/** Install before React mounts to avoid a flash of the wrong theme. */
export const initializeTheme = (): (() => void) => {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const refresh = (): void => applyTheme(readTheme())
  refresh()
  media.addEventListener("change", refresh)
  window.addEventListener("storage", refresh)
  window.addEventListener(themeEvent, refresh)
  return () => {
    media.removeEventListener("change", refresh)
    window.removeEventListener("storage", refresh)
    window.removeEventListener(themeEvent, refresh)
  }
}
