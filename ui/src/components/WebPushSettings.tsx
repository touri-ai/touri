import { useEffect, useMemo, useState } from "react"
import { t } from "../i18n"
import { createWebPushClient, type WebPushClient, type WebPushStatus } from "../webPush"

export const WebPushSettings = ({ enabled, client: supplied }: { enabled: boolean; client?: WebPushClient }) => {
  const client = useMemo(() => supplied ?? createWebPushClient(), [supplied])
  const [status, setStatus] = useState<WebPushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [sent, setSent] = useState(false)
  useEffect(() => {
    let active = true
    void client.getStatus().then(
      (next) => {
        if (active) setStatus(next)
      },
      () => {
        if (active) setError(true)
      },
    )

    return () => {
      active = false
    }
  }, [client])
  const run = async (action: "enable" | "disable" | "test") => {
    setBusy(true)
    setError(false)
    setSent(false)
    try {
      await client[action]()
      if (action === "test") setSent(true)
      else setStatus(await client.getStatus())
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-notification-delivery" aria-live="polite">
      <p className="field-help">
        {t(
          "Ative avisos neste aparelho para receber novidades mesmo com o touri fechado. O serviço de push do navegador recebe avisos criptografados. No celular, adicione o touri à tela de início e abra pelo ícone usando HTTPS.",
        )}
      </p>
      {status?.supported === false && (
        <p>
          {t("Este navegador ainda não permite avisos aqui. Abra o touri instalado pela tela de início usando HTTPS.")}
        </p>
      )}
      {status?.supported && (
        <>
          <p>{status.subscribed ? t("Avisos ativados neste aparelho.") : t("Avisos desativados neste aparelho.")}</p>
          <div className="notification-buttons">
            <button
              className="button button-quiet"
              type="button"
              disabled={busy || (!enabled && !status.subscribed)}
              onClick={() => void run(status.subscribed ? "disable" : "enable")}
            >
              {status.subscribed ? t("Desativar neste aparelho") : t("Ativar neste aparelho")}
            </button>
            {status.subscribed && (
              <button
                className="button button-quiet"
                type="button"
                disabled={busy || !enabled}
                onClick={() => void run("test")}
              >
                {t("Testar aviso")}
              </button>
            )}
          </div>
        </>
      )}
      {sent && <p>{t("Teste enviado. Confira se o aviso apareceu no sistema.")}</p>}
      {error && (
        <p role="alert">
          {t("Não foi possível ativar ou testar os avisos. Confira a permissão do navegador e tente novamente.")}
        </p>
      )}
    </div>
  )
}
