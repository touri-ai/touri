const PRELOAD_ERROR_EVENT = "vite:preloadError"
const RECOVERY_MARKER = "touri.lazy-asset-recovery"
const RECOVERY_MARKER_LIFETIME_MS = 30_000

type LazyAssetRecoveryOptions = {
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">
  getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined
  canReload: () => boolean
  reload: () => void
}

export const installBrowserLazyAssetRecovery = (): (() => void) =>
  installLazyAssetRecovery({
    target: window,
    getStorage: () => {
      try {
        return window.sessionStorage
      } catch {
        return undefined
      }
    },
    canReload: () => {
      if (!navigator.onLine) return false

      return document.querySelector('.attachment-strip li, [data-unsaved-draft="true"]') === null
    },
    reload: () => window.location.reload(),
  })

export const installLazyAssetRecovery = ({
  target,
  getStorage,
  canReload,
  reload,
}: LazyAssetRecoveryOptions): (() => void) => {
  const clearRecoveryMarker = () => {
    const storage = getStorage()
    if (!storage) return

    try {
      storage.removeItem(RECOVERY_MARKER)
    } catch {
      return
    }
  }
  const handlePreloadError: EventListener = (event) => {
    if (!canReload()) return

    const storage = getStorage()
    if (!storage) return

    try {
      if (storage.getItem(RECOVERY_MARKER) !== null) return
      storage.setItem(RECOVERY_MARKER, "1")
    } catch {
      return
    }

    event.preventDefault()
    reload()
  }

  target.addEventListener(PRELOAD_ERROR_EVENT, handlePreloadError)
  const resetTimer = setTimeout(clearRecoveryMarker, RECOVERY_MARKER_LIFETIME_MS)

  return () => {
    target.removeEventListener(PRELOAD_ERROR_EVENT, handlePreloadError)
    clearTimeout(resetTimer)
  }
}
