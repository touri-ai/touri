import { useEffect } from "react"
import { SETTINGS, type SettingDefinition } from "./settingsRegistry"

export const SETTING_HIGHLIGHT_MS = 2400

const controlIdFor = (settingId: string): string | undefined => {
  const definitions: Array<SettingDefinition> = Object.values(SETTINGS)
  return definitions.find((definition) => definition.id === settingId)?.controlId
}

const getClosedDisclosures = (row: HTMLElement): HTMLElement[] => {
  const parent = row.parentElement?.closest<HTMLElement>(".ds-disclosure")
  if (!parent) return []

  return [...getClosedDisclosures(parent), ...(parent.dataset.open === "true" ? [] : [parent])]
}

/** Focus and briefly highlight the registry row a palette result points at. */
export const focusSetting = (settingId: string): (() => void) => {
  const row = document.querySelector<HTMLElement>(`[data-setting-id="${settingId}"]`)
  if (!row) return () => undefined
  const disclosures = getClosedDisclosures(row)
  disclosures.forEach((disclosure) => {
    disclosure.querySelector<HTMLElement>(":scope > .ds-disclosure-trigger")?.click()
  })

  const controlId = controlIdFor(settingId)
  const control = controlId ? document.getElementById(controlId) : null
  const target = control ?? row
  if (!control && !row.hasAttribute("tabindex")) row.tabIndex = -1
  const focus = () => {
    row.scrollIntoView?.({ block: "center" })
    target.focus({ preventScroll: true })
  }
  // React commits the disclosure's visibility after the click handler returns.
  const frame = disclosures.length > 0 ? window.requestAnimationFrame(focus) : null
  if (frame === null) focus()

  row.dataset.settingHighlight = "true"
  const timer = window.setTimeout(() => {
    delete row.dataset.settingHighlight
  }, SETTING_HIGHLIGHT_MS)
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    window.clearTimeout(timer)
    delete row.dataset.settingHighlight
  }
}

/** Runs after the dialog's own initial focus so the requested setting wins. */
export const useSettingFocus = (settingId: string | null | undefined): void => {
  useEffect(() => {
    if (!settingId) return
    return focusSetting(settingId)
  }, [settingId])
}
