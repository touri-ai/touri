import type { ApiRoutes, TelegramIntegration } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { localizeNotice, t } from "../i18n"
import { ScreenState } from "./ScreenPrimitives"

type Patch = ApiRoutes["PUT /bots/:id/integrations/telegram"]["req"]

const parseIds = (value: string): Array<string> =>
  value
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean)

const statusText = (telegram: TelegramIntegration): string => {
  const { status } = telegram
  if (status.state === "connected")
    return status.username ? t("Conectado como @{username}", { username: status.username }) : t("Conectado")
  if (status.state === "connecting") return t("Conectando…")
  if (status.state === "error")
    return status.error ? localizeNotice(status.error) : t("Não foi possível carregar o Telegram deste bot.")
  return t("Desligado")
}

const statusClass = (telegram: TelegramIntegration): string =>
  telegram.status.state === "connected"
    ? "is-success"
    : telegram.status.state === "error"
      ? "is-error"
      : telegram.status.state === "connecting"
        ? "is-info"
        : ""

/** Per-bot Telegram bridge: off until the user saves a token, enables it and allows someone. */
export const TelegramIntegrationCard = ({ api, botId }: { api: UiApi; botId: string }) => (
  <TelegramCard key={botId} api={api} botId={botId} />
)

const TelegramCard = ({ api, botId }: { api: UiApi; botId: string }) => {
  const requestVersion = useRef(0)
  const [telegram, setTelegram] = useState<TelegramIntegration | null>(null)
  const [failed, setFailed] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState("")
  const [ids, setIds] = useState("")
  const [homeChatId, setHomeChatId] = useState("")
  const [forwardRoutines, setForwardRoutines] = useState(false)

  const apply = useCallback((next: TelegramIntegration) => {
    setTelegram(next)
    setIds(next.config.allowedUserIds.join(", "))
    setHomeChatId(next.config.homeChatId ?? "")
    setForwardRoutines(next.config.forwardRoutines)
  }, [])

  const load = useCallback(() => {
    const version = ++requestVersion.current
    setFailed(false)
    return api
      .request("GET /bots/:id/integrations/telegram", {}, { id: botId })
      .then((response) => {
        if (version === requestVersion.current) apply(response.telegram)
      })
      .catch(() => {
        if (version === requestVersion.current) setFailed(true)
      })
  }, [api, apply, botId])

  useEffect(() => {
    setTelegram(null)
    void load()
    return () => {
      requestVersion.current += 1
    }
  }, [load])

  const save = async (patch: Patch): Promise<void> => {
    if (busy) return
    const version = ++requestVersion.current
    setBusy(true)
    setSaveError(false)
    try {
      const response = await api.request("PUT /bots/:id/integrations/telegram", patch, { id: botId })
      if (version === requestVersion.current) {
        apply(response.telegram)
        if (patch.token) setToken("")
      }
    } catch {
      if (version === requestVersion.current) setSaveError(true)
    } finally {
      if (version === requestVersion.current) setBusy(false)
    }
  }

  if (failed)
    return (
      <ScreenState
        kind="error"
        description={t("Não foi possível carregar o Telegram deste bot.")}
        onRetry={() => void load()}
      />
    )
  if (!telegram) return <ScreenState kind="loading" />
  const rejected =
    telegram.lastRejected && !telegram.config.allowedUserIds.includes(telegram.lastRejected.userId)
      ? telegram.lastRejected
      : null

  return (
    <article className="screen-card screen-provider-card telegram-card" aria-labelledby={`telegram-${botId}`}>
      <div className="screen-card-heading">
        <span className="screen-provider-mark" aria-hidden="true">
          ✈
        </span>
        <h3 id={`telegram-${botId}`}>{t("Telegram")}</h3>
        <span className={`screen-status ${statusClass(telegram)}`} role="status">
          {statusText(telegram)}
        </span>
      </div>
      <p>{t("Converse com este bot pelo Telegram. Só as pessoas permitidas abaixo conseguem falar com ele.")}</p>
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={telegram.config.enabled}
            onChange={(event) => void save({ enabled: event.target.checked })}
          />{" "}
          {t("Ativar Telegram")}
        </label>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (token.trim()) void save({ token: token.trim() })
          }}
        >
          <label>
            {t("Token do bot")}
            <input
              type="password"
              autoComplete="off"
              value={token}
              placeholder={telegram.tokenSaved ? t("Token salvo") : t("Cole o token do @BotFather")}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="submit" className="outline-button" disabled={!token.trim()}>
            {t("Salvar token")}
          </button>
          {telegram.tokenSaved && (
            <button type="button" className="outline-button" onClick={() => void save({ token: null, enabled: false })}>
              {t("Remover token")}
            </button>
          )}
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save({ allowedUserIds: parseIds(ids), homeChatId: homeChatId.trim() || null, forwardRoutines })
          }}
        >
          <label>
            {t("IDs de usuário permitidos")}
            <input value={ids} inputMode="numeric" onChange={(event) => setIds(event.target.value)} />
          </label>
          <small>{t("Separe por vírgula. Vazio: ninguém consegue falar com o bot.")}</small>
          <label>
            {t("Chat para resultados de rotinas")}
            <input value={homeChatId} inputMode="numeric" onChange={(event) => setHomeChatId(event.target.value)} />
          </label>
          <label>
            <input
              type="checkbox"
              checked={forwardRoutines}
              onChange={(event) => setForwardRoutines(event.target.checked)}
            />{" "}
            {t("Enviar resultados das rotinas para esse chat")}
          </label>
          <button type="submit" className="outline-button">
            {t("Salvar Telegram")}
          </button>
        </form>
        {rejected && (
          <p className="telegram-rejected">
            {t("Pedido de {name} (ID {id})", { name: rejected.name, id: rejected.userId })}{" "}
            <button
              type="button"
              className="outline-button"
              onClick={() => void save({ allowedUserIds: [...telegram.config.allowedUserIds, rejected.userId] })}
            >
              {t("Permitir")}
            </button>
          </p>
        )}
      </fieldset>
      {saveError && <p role="alert">{t("Não foi possível salvar. Confira o token e tente novamente.")}</p>}
      <div className="screen-card-footer">
        <span>
          {t(
            "Crie um bot com o @BotFather e cole o token. Quando alguém mandar a primeira mensagem, o ID aparece aqui para você permitir.",
          )}
        </span>
        <button type="button" className="outline-button" disabled={busy} onClick={() => void load()}>
          {t("Atualizar status")}
        </button>
      </div>
    </article>
  )
}
