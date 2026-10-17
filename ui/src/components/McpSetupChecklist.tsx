import type { McpPrerequisites } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import type { McpPreset } from "./McpCatalog"

export const McpSetupChecklist = ({
  api,
  botId,
  preset,
  onReady,
  disabled,
}: {
  api: UiApi
  botId: string
  preset: McpPreset
  onReady: (ready: boolean) => void
  disabled: boolean
}) => {
  const [prerequisites, setPrerequisites] = useState<McpPrerequisites | null>(null)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recheck after preparation outside the app.
  useEffect(() => {
    let active = true
    setPrerequisites(null)
    setError(false)
    onReady(false)
    void api
      .request("GET /bots/:id/mcp/prerequisites", {}, { id: botId })
      .then(({ prerequisites }) => {
        if (!active) return
        setPrerequisites(prerequisites)
        onReady(
          prerequisites.status === "checked" &&
            prerequisites.node &&
            (preset.server.name !== "gmail" || (prerequisites.oauthKeys && prerequisites.credentials)),
        )
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [api, botId, preset, onReady, revision])
  const checked = prerequisites?.status === "checked"
  const nodeReady = checked && prerequisites.node
  const keysReady = checked && prerequisites.oauthKeys
  const credentialsReady = checked && prerequisites.credentials
  const gmail = preset.server.name === "gmail"
  const ready = nodeReady && (!gmail || (keysReady && credentialsReady))
  return (
    <section className="mcp-setup" aria-label={t("Preparar {name}", { name: preset.title })}>
      <h4>{t("Preparar {name}", { name: preset.title })}</h4>
      <p>{t("Faça a preparação na máquina em que o bot trabalha. Na VM, o login do Mac não é copiado.")}</p>
      {!prerequisites && !error && <p role="status">{t("Verificando a preparação…")}</p>}
      {error && <p role="alert">{t("Não foi possível verificar a preparação. Tente novamente.")}</p>}
      {prerequisites?.status === "unavailable" && (
        <p role="status">
          {prerequisites.machine === "cloud"
            ? t("Na nuvem, use uma conexão HTTP na configuração técnica.")
            : t("Ligue a máquina deste bot e clique em Verificar preparação novamente.")}
        </p>
      )}
      {checked && (
        <>
          {ready ? (
            <p>{t("Preparação concluída. Teste a conexão para continuar.")}</p>
          ) : (
            <ol>
              {!nodeReady && (
                <li>
                  <strong>{t("Instalar Node.js")}</strong>
                  <p>{t("Instale a versão 18 ou mais recente para executar a conexão.")}</p>
                  <a href="https://nodejs.org/en/download" target="_blank" rel="noreferrer">
                    {t("Baixar Node.js")}
                  </a>
                </li>
              )}
              {gmail && !keysReady && (
                <li>
                  <strong>{t("Criar o acesso no Google")}</strong>
                  <p>{t("Escolha ou crie um projeto no Google Cloud e ative a API do Gmail.")}</p>
                  <a
                    href="https://console.cloud.google.com/apis/library/gmail.googleapis.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Abrir Google Cloud")}
                  </a>
                  <p>{t("Crie uma credencial OAuth do tipo App para computador e baixe o arquivo JSON.")}</p>
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                    {t("Criar credencial")}
                  </a>
                  <p>
                    {t(
                      "Na pasta pessoal dessa máquina, crie a pasta .gmail-mcp e salve o arquivo como gcp-oauth.keys.json.",
                    )}
                  </p>
                </li>
              )}
              {gmail && !credentialsReady && (
                <li>
                  <strong>{t("Autorizar sua conta Google")}</strong>
                  <p>
                    {t(
                      "Abra o Terminal nessa máquina e cole este comando. No navegador, escolha a conta e revise o acesso solicitado.",
                    )}
                  </p>
                  <code>{preset.setup}</code>
                  <p>{t("Ao concluir, a autorização será salva em credentials.json na pasta .gmail-mcp.")}</p>
                </li>
              )}
            </ol>
          )}
          {!ready && <p>{t("Etapas já detectadas foram puladas. Depois de concluir, verifique novamente.")}</p>}
        </>
      )}
      <a href={preset.docs} target="_blank" rel="noreferrer">
        {t("Ver instruções completas de {name}", { name: preset.title })}
      </a>
      <button
        type="button"
        className="text-button"
        disabled={disabled || (!prerequisites && !error)}
        onClick={() => setRevision((value) => value + 1)}
      >
        {t("Verificar preparação novamente")}
      </button>
    </section>
  )
}
