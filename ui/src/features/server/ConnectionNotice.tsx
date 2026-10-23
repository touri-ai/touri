import { useState } from "react"
import type { TauriInvoke } from "../../api/client"
import { t } from "../../i18n"
import { isNativeDesktop } from "./serverMode"

export const ConnectionNotice = ({ incompatible = false, invoke }: { incompatible?: boolean; invoke: TauriInvoke }) => {
  const [updating, setUpdating] = useState(false)
  const [failed, setFailed] = useState(false)
  const update = async (): Promise<void> => {
    if (updating) return
    if (!isNativeDesktop()) {
      window.location.reload()
      return
    }
    setUpdating(true)
    setFailed(false)
    try {
      await invoke("updater_install", {})
    } catch {
      setFailed(true)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div
      className="notice-bar"
      role="status"
      aria-live="polite"
      data-connection-state={incompatible ? "incompatible" : "reconnecting"}
    >
      {incompatible
        ? t("Esta versão do aplicativo precisa de uma atualização para conversar com o servidor.")
        : t("Reconectando…")}
      {incompatible && (
        <button type="button" className="button button-quiet" disabled={updating} onClick={() => void update()}>
          {updating ? t("Atualizando…") : t("Atualizar agora")}
        </button>
      )}
      {failed && <span>{t("Não foi possível atualizar. Tente novamente.")}</span>}
    </div>
  )
}
