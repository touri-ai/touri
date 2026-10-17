import { listen } from "@tauri-apps/api/event"
import { createTauriInvoke, type TauriInvoke, type UiApi } from "./api/client"
import { getStorageScope } from "./storageScope"

export const computerKillSwitchEvent = "computer-kill-switch"

/** Capture before noVNC, the textarea or IME can forward the emergency chord to the guest. */
export const installComputerKillSwitch = (
  api: UiApi,
  invoke: TauriInvoke = createTauriInvoke(),
  onError: (error: unknown) => void = () => {},
) => {
  const revoke = () => window.dispatchEvent(new Event(computerKillSwitchEvent))
  const native = "__TAURI_INTERNALS__" in window && getStorageScope() === null
  const keydown = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.altKey || !event.metaKey || (event.code !== "Period" && event.key !== ".")) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.repeat) return
    revoke()
    void (async () => {
      try {
        if (native) await invoke("computer_kill_switch", {})
        else await api.request("POST /computer/kill", {})
      } catch (error) {
        // Still revoke remote viewers if the native bridge fails.
        await api.request("POST /computer/kill", {}).catch(onError)
        onError(error)
      }
    })()
  }
  window.addEventListener("keydown", keydown, true)
  let active = true
  let unlisten: (() => void) | undefined
  if (native)
    void listen(computerKillSwitchEvent, revoke)
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch(onError)
  return () => {
    active = false
    window.removeEventListener("keydown", keydown, true)
    unlisten?.()
  }
}
