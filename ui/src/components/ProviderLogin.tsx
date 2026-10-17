import type { ApiRoutes, Bot } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { SETTINGS } from "../features/commandPalette/settingsRegistry"
import { t } from "../i18n"
import { useProviderLogin } from "../useProviderLogin"
import { ProviderLoginFlow } from "./ProviderLoginFlow"

export const ProviderLogin = ({
  api,
  botId,
  provider,
  onConfigured,
  onReadyChange,
}: {
  api: UiApi
  botId: string
  provider: Bot["provider"]
  onConfigured: () => void
  onReadyChange?: (ready: boolean) => void
}) => {
  const login = useProviderLogin(api, botId, provider)
  const callbacks = useRef({ onConfigured, onReadyChange })
  callbacks.current = { onConfigured, onReadyChange }
  const ready = login.flow?.state === "ready" && login.flow.executable !== "missing"
  useEffect(() => {
    callbacks.current.onReadyChange?.(ready)
    if (ready) callbacks.current.onConfigured()
  }, [ready])
  const [status, setStatus] = useState<ApiRoutes["GET /bots/:id/provider-login"]["res"] | null>(null)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    if (botId.startsWith("draft-")) return
    try {
      setStatus(await api.request("GET /bots/:id/provider-login", {}, { id: botId }))
    } catch {
      setError(t("Não foi possível verificar o login."))
    }
  }, [api, botId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: discard the previous provider's login state when the draft provider changes
  useEffect(() => {
    setStatus(null)
    setError(null)
    setOpen(false)
    setValue("")
    if (ready) void refresh()
  }, [refresh, provider, ready])
  const save = async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await login.act("paste", value)
      if (result?.state !== "ready") return
      setValue("")
      setOpen(false)
      await refresh()
    } catch {
      setError(t("Não foi possível salvar o login no cofre de segredos."))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="provider-login"
      aria-label={t("Login do provedor nesta máquina")}
      data-setting-id={SETTINGS.providerLogin.id}
    >
      {!botId.startsWith("draft-") && (
        <label>
          Fonte do login
          <select
            id={SETTINGS.providerLogin.controlId}
            aria-label="Fonte do login"
            value={status?.configuredSource ?? "vault"}
            disabled={busy || !status || status.provider !== provider}
            onChange={(event) => {
              const input = {
                value: "",
                source: event.target.value === "host-file" ? ("host-file" as const) : ("vault" as const),
              }
              setBusy(true)
              void api
                .request("PUT /bots/:id/provider-login", input, { id: botId })
                .then(refresh)
                .catch(() => setError("Não foi possível selecionar a fonte de login."))
                .finally(() => setBusy(false))
            }}
          >
            <option value="vault">Cofre de segredos deste bot</option>
            <option value="host-file">Arquivo de login do host</option>
          </select>
        </label>
      )}
      <ProviderLoginFlow login={login} />
      <button
        type="button"
        className="button button-quiet"
        onClick={() => {
          if (login.flow?.state === "waiting") void login.act("cancel")
          setOpen(true)
        }}
      >
        {t("Colar token manualmente")}
      </button>
      {open && (
        <div>
          <p>
            {provider === "opencode"
              ? "Execute opencode auth login e cole o conteúdo de ~/.local/share/opencode/auth.json. O arquivo será compartilhado somente para leitura com esta máquina."
              : provider === "claude"
                ? t(
                    "No Terminal deste Mac, execute claude setup-token e cole o token OAuth abaixo. Ele será usado somente por este bot, na máquina escolhida para ele.",
                  )
                : t(
                    'Execute codex -c cli_auth_credentials_store="file" login --device-auth no terminal e cole o conteúdo de ~/.codex/auth.json abaixo.',
                  )}
          </p>
          <label>
            {provider === "opencode"
              ? "Login JSON do OpenCode"
              : provider === "claude"
                ? t("Token OAuth do Claude")
                : t("Login JSON do Codex")}
            <input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div className="provider-login-actions">
            <button
              type="button"
              className="button button-brand"
              disabled={busy || !value.trim()}
              onClick={() => void save()}
            >
              {busy ? t("Salvando…") : t("Salvar login no cofre")}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setValue("")
                setOpen(false)
              }}
            >
              {t("Cancelar")}
            </button>
          </div>
        </div>
      )}
      {status?.ready && status.provider === provider && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void api
              .request("DELETE /bots/:id/provider-login", {}, { id: botId })
              .then(refresh)
              .catch(() => setError(t("Não foi possível remover o login.")))
          }
        >
          {t("Remover login salvo deste bot")}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
