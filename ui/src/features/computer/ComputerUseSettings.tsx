import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState } from "react"
import { t } from "../../i18n"
import { hostComputerSupported } from "../../platform"

type PermissionState = "granted" | "denied" | "not-determined"
type Permission = "accessibility" | "screen-recording"
type PermissionsStatus = Record<Permission, PermissionState>
type PermissionsRequest = { status: PermissionState; needsRelaunch: boolean }

const labels: Record<Permission, string> = {
  accessibility: t("Accessibility"),
  "screen-recording": t("Screen Recording"),
}

const statusText = (state: PermissionState | null): string => {
  if (state === "granted") return t("Granted")
  if (state === "denied") return t("Denied")
  return t("Not granted")
}

export type ComputerUseSettingsProps = {
  className?: string
}

export const ComputerUseSettings = ({ className = "" }: ComputerUseSettingsProps) => {
  const [status, setStatus] = useState<PermissionsStatus | null>(null)
  const [busy, setBusy] = useState<Permission | null>(null)
  const [relaunch, setRelaunch] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hostComputerSupported || !("__TAURI_INTERNALS__" in window)) return
    let mounted = true
    const refresh = async (): Promise<void> => {
      try {
        const next = await invoke<PermissionsStatus>("permissions_status")
        if (mounted) setStatus(next)
      } catch (caught) {
        if (mounted) setError(caught instanceof Error ? caught.message : t("Permission status is unavailable"))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])

  const request = async (permission: Permission): Promise<void> => {
    setBusy(permission)
    setError(null)
    try {
      const result = await invoke<PermissionsRequest>("permissions_request", { permission })
      setRelaunch((current) => current || result.needsRelaunch)
      setStatus((current) => ({
        accessibility: current?.accessibility ?? "not-determined",
        "screen-recording": current?.["screen-recording"] ?? "not-determined",
        [permission]: result.status,
      }))
      if (result.status !== "granted") await invoke("permissions_open_settings", { permission })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Could not request permission"))
    } finally {
      setBusy(null)
    }
  }

  if (!("__TAURI_INTERNALS__" in window))
    return (
      <p className={className}>
        {t("Este servidor não tem uma área de trabalho para controlar. Você pode conversar e trabalhar com arquivos.")}
      </p>
    )

  if (!hostComputerSupported) return null
  return (
    <section
      className={`rounded-2xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">{t("Computer use")}</p>
          <h2 className="mt-1 font-display text-xl font-semibold">{t("Let a bot control this computer")}</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600 dark:text-stone-300">
            {t("Access is off by default. Grants are time-boxed, visible in the HUD, and can be stopped with ⌃⌥⌘.")}
          </p>
        </div>
        <span className="rounded-full bg-stone-100 px-3 py-1 font-mono text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
          {t("time-boxed")}
        </span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {(["accessibility", "screen-recording"] as const).map((permission) => (
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 p-3 dark:border-stone-800"
            key={permission}
          >
            <div>
              <p className="text-sm font-semibold">{labels[permission]}</p>
              <p className="font-mono text-xs text-stone-500">{statusText(status?.[permission] ?? null)}</p>
            </div>
            <button
              className="rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-brand disabled:cursor-wait disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
              disabled={busy !== null}
              onClick={() => void request(permission)}
              type="button"
            >
              {busy === permission ? t("Waiting…") : t("Grant")}
            </button>
          </div>
        ))}
      </div>
      {relaunch ? (
        <p className="mt-4 text-sm text-amber-700">{t("Screen Recording may require relaunching touri.")}</p>
      ) : null}
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
    </section>
  )
}
