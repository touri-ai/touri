import { useEffect, useId, useState } from "react"
import { createTauriInvoke, type TauriInvoke } from "../../api/client"
import { VaultAccessButton } from "../../components/VaultAccessButton"
import { t } from "../../i18n"
import { isNativeDesktop, serverModeError, serverModeErrorCode, useServerMode } from "./serverMode"

const nativeInvoke = createTauriInvoke()

export const ServerModeSettings = ({
  invokeCommand = nativeInvoke,
  connectionErrorCode,
}: {
  invokeCommand?: TauriInvoke | undefined
  connectionErrorCode?: string | null | undefined
}) => {
  const { status, error: statusError, errorCode: statusErrorCode, loading, refresh } = useServerMode(invokeCommand)
  const id = useId()
  const [url, setUrl] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  useEffect(() => {
    if (status?.url) setUrl(status.url)
  }, [status?.url])
  if (!isNativeDesktop()) return null

  const run = async (action: "pair" | "test" | "local") => {
    if (busy) return
    setBusy(true)
    setError(null)
    setErrorCode(null)
    setMessage(null)
    try {
      if (action === "pair") {
        const result = await invokeCommand("server_mode_pair", { url: url.trim(), code: code.trim() })
        if (result?.mode !== "server") throw new Error("SERVER_PAIR")
        setMessage(t("Servidor conectado. O touri vai reiniciar neste modo."))
      } else if (action === "test") {
        const result = await invokeCommand("server_mode_test", {})
        if (!result?.ok) throw new Error("SERVER_CONNECTION")
        setMessage(t("Conexão com o servidor confirmada."))
      } else {
        const result = await invokeCommand("server_mode_local", {})
        if (result?.mode !== "local") throw new Error("SERVER_LOCAL")
        setMessage(t("O touri vai reiniciar no modo local."))
      }
    } catch (caught) {
      setError(serverModeError(caught))
      setErrorCode(serverModeErrorCode(caught))
    } finally {
      if (action === "pair") setCode("")
      setBusy(false)
    }
  }

  return (
    <section className="server-mode-settings settings-group" aria-label={t("Usar um servidor touri")}>
      <h3>{t("Usar um servidor touri")}</h3>
      <p className="field-help">
        {t(
          "Seus bots, conversas, arquivos e logins ficam no servidor escolhido. Este aparelho mostra a interface, sem iniciar bots locais.",
        )}
      </p>
      <p className="field-help">
        {t("As pastas, a tela e o navegador pessoal deste aparelho não ficam disponíveis para os bots do servidor.")}
      </p>
      {status && (
        <p role="status">
          {status.mode === "server" ? t("Modo servidor ativo") : t("Modo local ativo")}
          {status.url && <> · {status.url}</>}
        </p>
      )}
      {loading && <p role="status">{t("Verificando modo do aplicativo…")}</p>}
      {status?.url && (errorCode ?? statusErrorCode ?? connectionErrorCode)?.startsWith("VAULT_") && (
        <VaultAccessButton account={`server-mode/${status.url}`} onAuthorized={() => run("test")} />
      )}
      <form
        className="settings-fields"
        onSubmit={(event) => {
          event.preventDefault()
          void run("pair")
        }}
      >
        <label htmlFor={`${id}-url`}>{t("Endereço do servidor")}</label>
        <input
          id={`${id}-url`}
          type="url"
          value={url}
          placeholder="https://touri.example"
          required
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
        />
        <p id={`${id}-help`} className="field-help">
          {t(
            "No computador do servidor, execute touri pair para gerar um código de uso único. Cole o código abaixo; ele expira em poucos minutos.",
          )}
        </p>
        <label htmlFor={`${id}-code`}>{t("Código de pareamento")}</label>
        <input
          id={`${id}-code`}
          type="password"
          value={code}
          required
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-help`}
          disabled={busy}
          onChange={(event) => setCode(event.target.value)}
        />
        <p className="field-help">
          {t(
            "A conexão fica guardada no cofre do sistema. Ao conectar ou voltar ao modo local, o aplicativo reinicia.",
          )}
        </p>
        <div className="modal-actions">
          <button type="submit" className="button button-brand" disabled={busy || !url.trim() || !code.trim()}>
            {busy ? t("Aguarde…") : t("Conectar ao servidor")}
          </button>
        </div>
      </form>
      <div className="modal-actions">
        {status?.mode === "server" && (
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void run("test")}>
            {t("Testar conexão")}
          </button>
        )}
        {(status?.mode === "server" || statusError) && (
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void run("local")}>
            {t("Voltar ao modo local")}
          </button>
        )}
        {statusError && (
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            {t("Tentar novamente")}
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {(error || statusError) && (
        <p className="warning-callout" role="alert">
          {error ?? statusError}
        </p>
      )}
    </section>
  )
}
