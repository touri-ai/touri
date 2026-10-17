import { useEffect, useId, useState } from "react"
import { localizeNotice, t } from "../i18n"
import type { useProviderLogin } from "../useProviderLogin"
import { ProviderInstallation } from "./ProviderInstallation"

export const ProviderLoginFlow = ({ login }: { login: ReturnType<typeof useProviderLogin> }) => {
  const { flow, error, busy, act } = login
  const hostIsMac = flow?.host === "mac"
  const [code, setCode] = useState("")
  const codeId = useId()
  useEffect(() => {
    if (!flow?.needsCode) setCode("")
  }, [flow?.needsCode])
  const sendCode = async () => {
    if (busy || !code.trim()) return
    const result = await act("code", code)
    if (result) setCode("")
  }
  if (flow?.executable === "missing")
    return (
      <ProviderInstallation
        provider={flow.provider}
        host={flow.host ?? "server"}
        busy={busy}
        onRecheck={() => void login.recheck()}
      />
    )
  if (error && flow?.state !== "waiting" && flow?.state !== "ready")
    return (
      <div className="provider-login-flow">
        <p role="alert">{error}</p>
        <button
          type="button"
          className="button button-brand"
          disabled={busy}
          onClick={() => void act(flow?.state === "host-available" ? "use-host" : "start")}
        >
          {t("Tentar novamente")}
        </button>
      </div>
    )
  return (
    <div className="provider-login-flow">
      <p aria-live="polite">
        {!flow
          ? t("Verificando login…")
          : flow.state === "waiting"
            ? t("Aguardando login no navegador…")
            : flow.state === "ready"
              ? t("Login disponível para este bot.")
              : flow.state === "host-available"
                ? t(hostIsMac ? "Há um login disponível neste Mac." : "Há um login disponível neste servidor.")
                : flow.state === "cancelled"
                  ? t("Login cancelado.")
                  : flow.state === "error"
                    ? t("Não foi possível concluir o login. Tente novamente ou cole o token manualmente.")
                    : t("Entre no provedor para enviar mensagens.")}
      </p>
      {flow?.state === "waiting" && (
        <>
          {flow.prompt && (
            <div>
              <p>
                {flow.prompt.kind === "provider" ? t("Escolha a conta no OpenCode") : t("Escolha o método de login")}:{" "}
                <strong>{flow.prompt.choice}</strong>
              </p>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => void act("input", undefined, "up")}
              >
                {t("Opção anterior")}
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => void act("input", undefined, "down")}
              >
                {t("Próxima opção")}
              </button>
              <button
                type="button"
                className="button button-brand"
                disabled={busy}
                onClick={() => void act("input", undefined, "enter")}
              >
                {t("Confirmar opção")}
              </button>
            </div>
          )}
          {flow.deviceCode && (
            <p>
              {t("Código de login")}: <strong>{flow.deviceCode}</strong>
            </p>
          )}
          {flow.needsCode && (
            <div>
              <label htmlFor={codeId}>{t("Código exibido no navegador")}</label>
              <input
                id={codeId}
                type="text"
                value={code}
                maxLength={2000}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-invalid={!!flow.codeError}
                aria-describedby={flow.codeError ? `${codeId}-error` : undefined}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void sendCode()
                  }
                }}
              />
              <button
                type="button"
                className="button button-brand"
                disabled={busy || !code.trim()}
                onClick={() => void sendCode()}
              >
                {t("Enviar código")}
              </button>
              {flow.codeError && (
                <p id={`${codeId}-error`} role="alert">
                  {localizeNotice(flow.codeError)}
                </p>
              )}
            </div>
          )}
          {flow.verificationUrl && (
            <a
              href={flow.verificationUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                if (flow.verificationUrl) void login.openPage(flow.verificationUrl)
              }}
            >
              {t("Abrir página de login")}
            </a>
          )}
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void act("cancel")}>
            {t("Cancelar login")}
          </button>
        </>
      )}
      {flow?.state === "host-available" && (
        <button type="button" className="button button-brand" disabled={busy} onClick={() => void act("use-host")}>
          {t(hostIsMac ? "Usar login deste Mac" : "Usar login deste servidor")}
        </button>
      )}
      {flow && flow.state !== "waiting" && flow.state !== "ready" && (
        <button type="button" className="button button-quiet" disabled={busy} onClick={() => void act("start")}>
          {t("Entrar no navegador")}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
