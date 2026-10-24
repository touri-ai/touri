import type { BotGroup, InviteDelivery, PersonRole } from "@touri/contracts"
import { useId, useState } from "react"
import type { UiApi } from "../../api/client"
import { Modal } from "../../components/Modal"
import { type Locale, t } from "../../i18n"
import {
  getChannelNames,
  getDeliveryNotice,
  getInviteErrorMessage,
  inviteRoles,
  isInviteFormValid,
  toggleChannel,
} from "./invites"
import "./people.css"

type Busy = "send" | "resend" | "revoke" | null

export const InvitePersonDialog = ({
  channels,
  initialChannelId,
  request,
  onClose,
  locale = "pt-BR",
}: {
  channels: BotGroup[]
  initialChannelId?: string
  request: UiApi["request"]
  onClose: () => void
  locale?: Locale
}) => {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<PersonRole>("member")
  const [selected, setSelected] = useState<string[]>(initialChannelId ? [initialChannelId] : [])
  const [delivery, setDelivery] = useState<InviteDelivery | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [manualCopy, setManualCopy] = useState(false)
  const nameId = useId()
  const emailId = useId()

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    if (busy) return

    setBusy(kind)
    setError(null)
    setStatus(null)
    try {
      await action()
    } catch (failure) {
      setError(getInviteErrorMessage(failure, locale))
    }
    setBusy(null)
  }

  const send = () =>
    run("send", async () => {
      const sent = await request("POST /invites", {
        name: name.trim(),
        email: email.trim(),
        role,
        channelIds: selected,
      })
      setDelivery(sent)
      setManualCopy(false)
    })

  const resend = () =>
    run("resend", async () => {
      if (!delivery) return

      setDelivery(await request("POST /invites/:id/resend", {}, { id: delivery.invite.id }))
      setManualCopy(false)
    })

  const revoke = () =>
    run("revoke", async () => {
      if (!delivery) return

      await request("DELETE /invites/:id", {}, { id: delivery.invite.id })
      setDelivery(null)
      setStatus(t("Convite revogado. O link não funciona mais.", {}, locale))
    })

  const copyLink = async () => {
    if (!delivery) return

    try {
      await navigator.clipboard.writeText(delivery.link)
      setManualCopy(false)
      setStatus(t("Link copiado", {}, locale))
    } catch {
      setManualCopy(true)
      setStatus(t("Não foi possível copiar sozinho. Selecione o link abaixo e copie.", {}, locale))
    }
  }

  return (
    <Modal
      title={t("Convidar pessoa", {}, locale)}
      className="invite-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      {delivery ? (
        <InviteSent
          delivery={delivery}
          channels={channels}
          busy={busy}
          error={error}
          status={status}
          manualCopy={manualCopy}
          locale={locale}
          onResend={() => void resend()}
          onCopy={() => void copyLink()}
          onRevoke={() => void revoke()}
          onBack={() => setDelivery(null)}
          onDone={onClose}
        />
      ) : (
        <form
          className="modal-form invite-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (isInviteFormValid({ name, email })) void send()
          }}
        >
          <label htmlFor={nameId}>{t("Nome", {}, locale)}</label>
          <input
            id={nameId}
            data-initial-focus
            value={name}
            maxLength={80}
            autoComplete="off"
            disabled={busy !== null}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor={emailId}>{t("E-mail", {}, locale)}</label>
          <input
            id={emailId}
            type="email"
            value={email}
            autoComplete="off"
            disabled={busy !== null}
            onChange={(event) => setEmail(event.target.value)}
          />
          <p className="field-help">{t("Opcional. Sem e-mail, compartilhe o link ou código.", {}, locale)}</p>
          <div role="radiogroup" aria-label={t("Papel", {}, locale)} className="invite-roles">
            <span className="invite-label">{t("Papel", {}, locale)}</span>
            {inviteRoles.map((option) => (
              // biome-ignore lint/a11y/useSemanticElements: a card-style radio needs a button.
              <button
                type="button"
                role="radio"
                aria-checked={role === option.id}
                className="invite-role"
                key={option.id}
                onClick={() => setRole(option.id)}
              >
                <strong>{t(option.name, {}, locale)}</strong>
                <span>{t(option.description, {}, locale)}</span>
              </button>
            ))}
          </div>
          <div className="invite-channels">
            <span className="invite-label">{t("Canais", {}, locale)}</span>
            {channels.length === 0 && (
              <p className="field-help">{t("Crie um canal para escolher onde a pessoa entra.", {}, locale)}</p>
            )}
            <div className="invite-chips">
              {channels.map((channel) => (
                <button
                  type="button"
                  className="invite-chip"
                  aria-pressed={selected.includes(channel.id)}
                  key={channel.id}
                  onClick={() => setSelected(toggleChannel(selected, channel.id))}
                >
                  # {channel.name}
                </button>
              ))}
            </div>
          </div>
          {status && <p role="status">{status}</p>}
          {error && <p role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="button button-quiet" disabled={busy !== null} onClick={onClose}>
              {t("Cancelar", {}, locale)}
            </button>
            <button
              type="submit"
              className="brand-button"
              disabled={busy !== null || !isInviteFormValid({ name, email })}
            >
              {t(busy === "send" ? "Enviando convite…" : "Enviar convite", {}, locale)}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

const InviteSent = ({
  delivery,
  channels,
  busy,
  error,
  status,
  manualCopy,
  locale,
  onResend,
  onCopy,
  onRevoke,
  onBack,
  onDone,
}: {
  delivery: InviteDelivery
  channels: BotGroup[]
  busy: Busy
  error: string | null
  status: string | null
  manualCopy: boolean
  locale: Locale
  onResend: () => void
  onCopy: () => void
  onRevoke: () => void
  onBack: () => void
  onDone: () => void
}) => {
  const { invite } = delivery
  const notice = getDeliveryNotice(delivery, invite.name, locale)
  const channelNames = getChannelNames(channels, invite.channelIds)
  const channelLine = channelNames
    ? t("Conversar em {channels} e chamar bots com @.", { channels: channelNames }, locale)
    : t("Conversar nos canais que você adicionar depois e chamar bots com @.", {}, locale)
  const abilities =
    invite.role === "admin"
      ? [channelLine, t("Convidar outras pessoas, criar canais e bots e mudar o que cada bot pode fazer.", {}, locale)]
      : [
          channelLine,
          t("Aprovar pedidos dos bots pelos quais responde.", {}, locale),
          t("Não vê as suas conversas a sós com bots nem a configuração do servidor.", {}, locale),
        ]

  return (
    <div className="modal-form invite-sent">
      <p className="invite-sent-line">
        <span className={`invite-badge ${delivery.emailSent ? "invite-badge-ok" : ""}`}>
          {t(notice.badge, {}, locale)}
        </span>
        {delivery.emailSent && <span>{t("Convite enviado para {email}", { email: invite.email }, locale)}</span>}
      </p>
      <p className="field-help">{notice.text}</p>
      {delivery.code && (
        <label>
          {t("Código do convite", {}, locale)}
          <input readOnly value={delivery.code} onFocus={(event) => event.currentTarget.select()} />
        </label>
      )}
      <p className="field-help">
        {t("Abra /join no endereço do time e informe o código. Válido por 24 horas, para uma pessoa.", {}, locale)}
      </p>
      <div className="invite-actions">
        {delivery.emailConfigured && (
          <button type="button" className="button" disabled={busy !== null} onClick={onResend}>
            {t(busy === "resend" ? "Reenviando…" : "Reenviar", {}, locale)}
          </button>
        )}
        <button
          type="button"
          className={delivery.emailConfigured ? "button button-quiet" : "brand-button"}
          onClick={onCopy}
        >
          {t("Copiar link", {}, locale)}
        </button>
        <button type="button" className="button button-quiet" disabled={busy !== null} onClick={onRevoke}>
          {t("Revogar", {}, locale)}
        </button>
      </div>
      {manualCopy && (
        <input
          className="invite-link"
          aria-label={t("Link do convite", {}, locale)}
          readOnly
          value={delivery.link}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="invite-abilities">
        <strong>{t("O que {name} vai poder fazer", { name: invite.name }, locale)}</strong>
        {abilities.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
      <div className="modal-actions invite-footer">
        <button type="button" className="button button-quiet" disabled={busy !== null} onClick={onBack}>
          {t("Voltar", {}, locale)}
        </button>
        <button type="button" className="brand-button" onClick={onDone}>
          {t("Pronto", {}, locale)}
        </button>
      </div>
    </div>
  )
}
