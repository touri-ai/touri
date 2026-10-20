import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState } from "react"
import { t } from "../i18n"
import "./notification-delivery.css"

type Permission = "granted" | "denied" | "not-determined" | "unknown"

/** A saved preference is not evidence that the OS delivered anything. */
export const NotificationDeliverySettings = ({ enabled }: { enabled: boolean }) => {
  const native = "__TAURI_INTERNALS__" in window
  const [permission, setPermission] = useState<Permission>("unknown")
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!native) return
    let active = true
    const refresh = () => {
      void invoke<Permission>("notification_permission").then(
        (value) => {
          if (active) setPermission(value)
        },
        () => {
          if (active) setPermission("unknown")
        },
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      active = false
      window.removeEventListener("focus", refresh)
    }
  }, [native])
  if (!native)
    return (
      <div className="settings-notification-delivery">
        <p className="field-help">
          {t("Com o touri fechado, você não recebe avisos. Ao abrir, as solicitações pendentes aparecem.")}
        </p>
      </div>
    )
  const test = async () => {
    setBusy(true)
    setError(false)
    setSent(false)
    try {
      const result = await invoke<Permission>("notification_test", {
        title: t("Aviso de teste do touri"),
        body: t("Se este aviso apareceu, a entrega está funcionando."),
      })
      setPermission(result)
      setSent(result === "granted" || result === "unknown")
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="settings-notification-delivery" aria-live="polite">
      <p>
        {permission === "denied"
          ? t("Os avisos do sistema estão desativados.")
          : permission === "granted"
            ? enabled
              ? t("O sistema permite avisos. Teste a entrega.")
              : t("Os avisos estão desativados no touri.")
            : permission === "not-determined"
              ? t("O sistema ainda não autorizou os avisos.")
              : t("Não foi possível verificar a autorização do sistema. Teste a entrega.")}
      </p>
      <div className="notification-buttons">
        <button
          className="button button-quiet"
          type="button"
          onClick={() => void invoke("notification_open_settings").catch(() => setError(true))}
        >
          {t("Abrir ajustes")}
        </button>
        <button className="button button-quiet" type="button" disabled={busy} onClick={() => void test()}>
          {t("Testar aviso")}
        </button>
      </div>
      {sent && <p>{t("Teste enviado. Confira se o aviso apareceu no sistema.")}</p>}
      {error && <p role="alert">{t("Não foi possível testar os avisos. Abra os ajustes e tente novamente.")}</p>}
    </div>
  )
}
