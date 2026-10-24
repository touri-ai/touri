import { useState } from "react"
import type { TauriInvoke } from "../../api/client"
import type { ConnectionStatus } from "../../api/connectionStatus"
import { t } from "../../i18n"
import { isNativeDesktop } from "./serverMode"

export const ConnectionNotice = ({
  incompatible = false,
  recovery = false,
  status,
  onRetry,
  onPair,
  invoke,
}: {
  incompatible?: boolean
  recovery?: boolean
  status?: ConnectionStatus | undefined
  onRetry?: (() => void) | undefined
  onPair?: (() => void) | undefined
  invoke: TauriInvoke
}) => {
  const [updating, setUpdating] = useState(false)
  const [failed, setFailed] = useState(false)
  const state = incompatible ? "incompatible" : (status?.state ?? "unavailable")
  const needsUpdate = state === "incompatible"
  const needsPairing = state === "session-expired"
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

  if (state === "connected") return null

  return (
    <div
      className={recovery ? "connection-recovery" : "notice-bar connection-status notice-info"}
      role="status"
      aria-live="polite"
      data-connection-state={getConnectionState(state)}
      data-connection-reason={state}
      data-connection-attempt={status?.attempt ?? 0}
      data-connection-retry-at={status?.retryAt ?? undefined}
    >
      <span>
        {needsUpdate
          ? t("Esta versão do aplicativo precisa de uma atualização para conversar com o servidor.")
          : getConnectionDescription(state, status)}
      </span>
      {needsPairing && (
        <>
          {onPair ? (
            <button type="button" className="button button-quiet" onClick={onPair}>
              {t("Parear novamente")}
            </button>
          ) : (
            <a className="button button-quiet" href="/login" target="_blank" rel="noopener noreferrer">
              {t("Parear novamente")}
            </a>
          )}
          {onRetry && (
            <button type="button" className="button button-quiet" onClick={onRetry}>
              {t("Verificar acesso")}
            </button>
          )}
        </>
      )}
      {(state === "unavailable" || state === "connecting") && onRetry && (
        <button type="button" className="button button-quiet" onClick={onRetry}>
          {t("Tentar agora")}
        </button>
      )}
      {needsUpdate && (
        <button
          type="button"
          className={`button ${recovery ? "button-brand" : "button-quiet"}`}
          disabled={updating}
          onClick={() => void update()}
        >
          {updating ? t("Atualizando…") : t("Atualizar agora")}
        </button>
      )}
      {failed && <span>{t("Não foi possível atualizar. Tente novamente.")}</span>}
    </div>
  )
}

const getConnectionState = (state: ConnectionStatus["state"]): string => {
  if (state === "unavailable" || state === "connecting") return "reconnecting"

  return state
}

const getConnectionDescription = (state: ConnectionStatus["state"], status: ConnectionStatus | undefined): string => {
  if (state === "offline") return t("Este aparelho está sem internet. Conecte-se à rede; a reconexão é automática.")
  if (state === "session-expired")
    return t(
      "A sessão expirou ou o acesso foi revogado. Pareie novamente e verifique o acesso aqui. Mensagens pendentes e histórico são mantidos.",
    )
  if (!status) return t("Reconectando…")
  if (status.retryAt !== null)
    return t(
      "Servidor indisponível. Tentativa {attempt} falhou. Nova tentativa automática agendada. Confira se o servidor está ligado.",
      { attempt: status.attempt },
    )

  return t("Conectando ao servidor. Tentativa {attempt} em andamento. Aguarde ou confira a rede e o servidor.", {
    attempt: status.attempt,
  })
}
