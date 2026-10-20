import type { Mem0Settings, Mem0SettingsPatch } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { Disclosure } from "./Disclosure"
import { SettingsSwitch } from "./SettingsLayout"

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; text: string } | { kind: "error"; text: string }

/** Optional Mem0 memory for one bot. The key is write-only: the card only learns whether one is saved. */
export const Mem0Card = ({ api, botId }: { api: UiApi; botId: string }) => {
  return <Mem0CardForm key={botId} api={api} botId={botId} />
}

const Mem0CardForm = ({ api, botId }: { api: UiApi; botId: string }) => {
  const [saved, setSaved] = useState<Mem0Settings | null>(null)
  const [draft, setDraft] = useState<Mem0Settings | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  useEffect(() => {
    let current = true
    setSaved(null)
    setDraft(null)
    setApiKey("")
    setLoadError(false)
    setStatus({ kind: "idle" })
    api
      .request("GET /bots/:id/mem0", {}, { id: botId })
      .then(({ settings }) => {
        if (!current) return
        setSaved(settings)
        setDraft(settings)
      })
      .catch(() => {
        if (current) setLoadError(true)
      })
    return () => {
      current = false
    }
  }, [api, botId])

  const save = async (patch: Mem0SettingsPatch) => {
    setStatus({ kind: "busy" })
    try {
      const { settings } = await api.request("PUT /bots/:id/mem0", patch, { id: botId })
      setSaved(settings)
      setDraft(settings)
      setApiKey("")
      setStatus({ kind: "ok", text: t("Salvo.") })
    } catch {
      setStatus({ kind: "error", text: t("Não foi possível salvar. Confira os campos e tente de novo.") })
    }
  }
  const test = async () => {
    setStatus({ kind: "busy" })
    try {
      const result = await api.request("POST /bots/:id/mem0/test", {}, { id: botId })
      setStatus(
        result.ok
          ? { kind: "ok", text: t("Conexão funcionando.") }
          : { kind: "error", text: result.error ?? t("Não foi possível salvar. Confira os campos e tente de novo.") },
      )
    } catch {
      setStatus({ kind: "error", text: t("Não foi possível salvar. Confira os campos e tente de novo.") })
    }
  }

  if (loadError)
    return (
      <article className="screen-card screen-provider-card mem0-card">
        <h3>{t("Memória Mem0")}</h3>
        <p role="alert">{t("Não foi possível carregar o Mem0.")}</p>
      </article>
    )
  if (!draft || !saved) return null
  const busy = status.kind === "busy"
  const dirty = apiKey !== "" || JSON.stringify(draft) !== JSON.stringify(saved)
  const hasDestinationChanged =
    draft.mode !== saved.mode || (draft.mode === "server" && draft.url.replace(/\/+$/, "") !== saved.url)
  const update = (patch: Partial<Mem0Settings>) => {
    setDraft({ ...draft, ...patch })
    setStatus({ kind: "idle" })
  }
  const { hasApiKey: _hasApiKey, ...fields } = draft
  return (
    <article className="screen-card screen-provider-card mem0-card" aria-labelledby={`mem0-title-${botId}`}>
      <div className="screen-card-heading">
        <span className="screen-provider-mark" aria-hidden="true">
          ◎
        </span>
        <h3 id={`mem0-title-${botId}`}>{t("Memória Mem0")}</h3>
        <span className={`screen-status ${saved.enabled ? "is-success" : ""}`}>
          {saved.enabled ? t("Ligado") : t("Desligado")}
        </span>
      </div>
      <p>
        {t(
          "Lembra fatos sobre você entre conversas. Antes de cada mensagem, o bot busca no Mem0 o que já sabe; depois, envia a troca para o Mem0 extrair fatos novos.",
        )}
      </p>
      <form
        className="mem0-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save({ ...fields, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
        }}
      >
        <fieldset disabled={busy}>
          <label className="mem0-toggle" htmlFor={`mem0-enabled-${botId}`}>
            <SettingsSwitch
              id={`mem0-enabled-${botId}`}
              checked={draft.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            {t("Ativar Mem0 para este bot")}
          </label>
          <label>
            {t("Onde ficam as memórias")}
            <select
              value={draft.mode}
              onChange={(event) => update({ mode: event.target.value === "server" ? "server" : "platform" })}
            >
              <option value="platform">{t("Mem0 Cloud")}</option>
              <option value="server">{t("Servidor próprio")}</option>
            </select>
          </label>
          {draft.mode === "server" && (
            <label>
              {t("URL do servidor")}
              <input
                type="url"
                placeholder="http://localhost:8888"
                value={draft.url}
                onChange={(event) => update({ url: event.target.value })}
              />
            </label>
          )}
          <label>
            {t("Chave da API")}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={saved.hasApiKey ? "••••••••" : ""}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {saved.hasApiKey && hasDestinationChanged && !apiKey.trim() && (
            <p className="field-help">
              {t("Ao mudar o destino, a chave anterior é removida. Digite a nova chave antes de salvar.")}
            </p>
          )}
          {saved.hasApiKey && (
            <p className="field-help">
              {t("Chave salva. Digite outra para trocar.")}{" "}
              <button type="button" className="link-button" onClick={() => void save({ apiKey: null })}>
                {t("Remover chave")}
              </button>
            </p>
          )}
          <label>
            {t("Alcance")}
            <select
              value={draft.scope}
              onChange={(event) => update({ scope: event.target.value === "bot" ? "bot" : "user" })}
            >
              <option value="user">{t("Memórias sobre você, compartilhadas entre bots")}</option>
              <option value="bot">{t("Só deste bot")}</option>
            </select>
          </label>
          <label className="mem0-toggle" htmlFor={`mem0-sync-${botId}`}>
            <SettingsSwitch
              id={`mem0-sync-${botId}`}
              checked={draft.autoSync}
              onChange={(event) => update({ autoSync: event.target.checked })}
            />
            {t("Enviar cada conversa ao Mem0 automaticamente")}
          </label>
          <Disclosure summary={t("Avançado")}>
            <label>
              {t("Memórias por busca")}
              <input
                type="number"
                min={1}
                max={20}
                value={draft.topK}
                onChange={(event) => update({ topK: Number(event.target.value) })}
              />
            </label>
            <label>
              {t("Relevância mínima (0 a 1)")}
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={draft.threshold}
                onChange={(event) => update({ threshold: Number(event.target.value) })}
              />
            </label>
          </Disclosure>
          <p className="field-help">
            {draft.mode === "server"
              ? t(
                  "Com o Mem0 ligado, o texto das suas mensagens e das respostas deste bot vai para o seu servidor Mem0, que o repassa ao modelo configurado nele.",
                )
              : t(
                  "Com o Mem0 ligado, o texto das suas mensagens e das respostas deste bot vai para o Mem0 Cloud.",
                )}{" "}
            {t("O Mem0 não é usado em grupos, rotinas nem pedidos delegados.")}
          </p>
          {dirty && <p className="field-help">{t("Salve as alterações antes de testar a conexão.")}</p>}
          <div className="screen-card-footer">
            <button type="button" className="outline-button" disabled={dirty} onClick={() => void test()}>
              {t("Testar conexão")}
            </button>
            <button type="submit" className="brand-button">
              {t("Salvar Mem0")}
            </button>
          </div>
          {status.kind === "ok" && <p role="status">{status.text}</p>}
          {status.kind === "error" && <p role="alert">{status.text}</p>}
        </fieldset>
      </form>
    </article>
  )
}
