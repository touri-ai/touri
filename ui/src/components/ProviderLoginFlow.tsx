import { useEffect, useId, useState } from "react"
import { getHostLabel, localizeNotice, t } from "../i18n"
import type { useProviderLogin } from "../useProviderLogin"
import { ProviderInstallation } from "./ProviderInstallation"
import { VaultAccessButton } from "./VaultAccessButton"
import "./provider-login-flow.css"

export const ProviderLoginFlow = ({
  login,
  resumeMessage = false,
}: {
  login: ReturnType<typeof useProviderLogin>
  resumeMessage?: boolean
}) => {
  const { flow, error, busy, act, recheck } = login
  const provider = login.provider === "claude" ? "Claude" : login.provider === "codex" ? "Codex" : "OpenCode"
  const hostKind = flow?.hostKind ?? flow?.host
  const host = getHostLabel(hostKind ?? "computer")
  const serverLogin = hostKind === "server" || hostKind === "computer"
  const desktopMethod =
    serverLogin &&
    flow?.prompt?.kind === "method" &&
    /\bbrowser\b/i.test(flow.prompt.choice) &&
    !/\bheadless\b/i.test(flow.prompt.choice)
  const [copyNotice, setCopyNotice] = useState<{ code: string; message: string } | null>(null)
  const [code, setCode] = useState("")
  const codeId = useId()
  useEffect(() => {
    if (!flow?.needsCode) setCode("")
  }, [flow?.needsCode])
  const copyCode = async () => {
    if (!flow?.deviceCode) return
    try {
      await navigator.clipboard.writeText(flow.deviceCode)
      setCopyNotice({ code: flow.deviceCode, message: t("Código copiado.") })
    } catch {
      setCopyNotice({ code: flow.deviceCode, message: t("Não foi possível copiar. Selecione e copie o código acima.") })
    }
  }
  const sendCode = async () => {
    if (busy || !code.trim()) return
    const result = await act("code", code)
    if (result) setCode("")
  }
  if (flow?.executable === "missing")
    return (
      <ProviderInstallation
        provider={flow.provider}
        host={hostKind ?? "computer"}
        busy={busy}
        onRecheck={() => void login.recheck()}
      />
    )
  return (
    <div className="provider-login-flow">
      <p aria-live="polite" role={error && flow?.state !== "waiting" ? "alert" : undefined}>
        {error && flow?.state !== "waiting"
          ? error
          : !flow
            ? t("Verificando login…")
            : flow.state === "waiting"
              ? serverLogin
                ? flow.verificationUrl
                  ? t("Sign in to {provider} for this {host}: open this link on this device", { provider, host })
                  : t("Preparing {provider} sign-in for this {host}…", { provider, host })
                : t("Aguardando login no navegador…")
              : flow.state === "ready"
                ? t("Login disponível para este bot.")
                : flow.state === "host-available"
                  ? t("A login is available on this {host}.", { host })
                  : flow.state === "vault-locked"
                    ? t("Permita o acesso ao cofre para usar o login salvo.")
                    : flow.state === "cancelled"
                      ? t("Login cancelado.")
                      : flow.state === "error"
                        ? (serverLogin || flow.retryable) && flow.message
                          ? localizeNotice(flow.message)
                          : t("Não foi possível concluir o login. Verifique de novo ou use outra conta.")
                        : t("Entre no provedor para enviar mensagens.")}
      </p>
      {flow?.state === "vault-locked" && (
        <VaultAccessButton
          resumeMessage={resumeMessage}
          account={`bot/${login.botId}/${login.provider}-vm-login`}
          onAuthorized={recheck}
        />
      )}
      {flow?.state === "waiting" && (
        <>
          {serverLogin && <p>{t("O login expira em até 10 minutos. Você pode cancelar a qualquer momento.")}</p>}
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
              {serverLogin && <p>{t("Escolha um método com código para entrar por este aparelho.")}</p>}
              <button
                type="button"
                className="button button-brand"
                disabled={busy || desktopMethod}
                onClick={() => void act("input", undefined, "enter")}
              >
                {t("Confirmar opção")}
              </button>
            </div>
          )}
          {flow.deviceCode && (
            <div className="provider-device-code">
              <label htmlFor={`${codeId}-device`}>{t("Código de login")}</label>
              <input id={`${codeId}-device`} value={flow.deviceCode} readOnly spellCheck={false} autoComplete="off" />
              <button type="button" className="button button-quiet" onClick={() => void copyCode()}>
                {t("Copiar código")}
              </button>
              {copyNotice?.code === flow.deviceCode && <p role="status">{copyNotice.message}</p>}
            </div>
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
              className="provider-verification-link"
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (serverLogin) return
                event.preventDefault()
                if (flow.verificationUrl) void login.openPage(flow.verificationUrl)
              }}
            >
              {t("Abrir página de login")}
            </a>
          )}
          {serverLogin && (
            <button
              type="button"
              className="button button-quiet"
              disabled={busy}
              onClick={() => void act("cancel").then((result) => result && act("start"))}
            >
              {t("Tentar de novo")}
            </button>
          )}
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void act("cancel")}>
            {t("Cancelar login")}
          </button>
        </>
      )}
      {flow?.state === "host-available" && (
        <button type="button" className="button button-brand" disabled={busy} onClick={() => void act("use-host")}>
          {t("Use this {host}'s login", { host })}
        </button>
      )}
      {flow &&
        flow.state !== "waiting" &&
        flow.state !== "ready" &&
        flow.state !== "vault-locked" &&
        !(flow.state === "error" && serverLogin && !flow.retryable) && (
          <button type="button" className="button button-quiet" disabled={busy} onClick={() => void act("start")}>
            {flow.retryable || flow.state === "cancelled"
              ? t("Tentar de novo")
              : flow.state === "idle"
                ? t("Entrar no {provider}", { provider })
                : t("Usar outra conta")}
          </button>
        )}
      {flow?.state !== "waiting" &&
        flow?.state !== "ready" &&
        flow?.state !== "host-available" &&
        flow?.state !== "vault-locked" && (
          <button type="button" className="button button-brand" disabled={busy} onClick={() => void recheck()}>
            {t("Verificar de novo")}
          </button>
        )}
      {error && flow?.state === "waiting" && <p role="alert">{error}</p>}
    </div>
  )
}
