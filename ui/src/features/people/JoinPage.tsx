import { type FormEvent, useId, useState } from "react"
import { type TranslationKey, t } from "../../i18n"
import { getInviteToken, getJoinMessage, redeemInvite } from "./join"
import "./people.css"

const getDefaultDeviceName = (): string => t("Navegador")

export const JoinPage = ({
  hash,
  redeem = redeemInvite,
  onJoined,
}: {
  hash: string
  redeem?: typeof redeemInvite
  onJoined: () => void
}) => {
  const [token, setToken] = useState(() => getInviteToken(hash))
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [deviceName, setDeviceName] = useState(getDefaultDeviceName)
  const [busy, setBusy] = useState(false)
  const [joined, setJoined] = useState(false)
  const [message, setMessage] = useState<TranslationKey | null>(null)
  const emailId = useId()
  const deviceId = useId()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !token || !name.trim()) return

    setBusy(true)
    setMessage(null)
    const result = await redeem({ token, email, deviceName, name })
    if (!result.ok) {
      setMessage(result.message)
      setBusy(false)
      return
    }

    setJoined(true)
    onJoined()
  }

  return (
    <main className="join-page">
      <form className="join-card" onSubmit={(event) => void submit(event)}>
        <h1>{t("Entrar no touri")}</h1>
        <p>{t("Cole o código recebido ou abra o link do convite.")}</p>
        <label>
          {t("Código do convite")}
          <input
            value={token}
            autoComplete="off"
            maxLength={256}
            required
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label>
          {t("Seu nome")}
          <input
            value={name}
            autoComplete="name"
            maxLength={80}
            required
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor={emailId}>{t("E-mail do convite")}</label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor={deviceId}>{t("Nome deste aparelho")}</label>
        <input
          id={deviceId}
          value={deviceName}
          maxLength={80}
          disabled={busy}
          onChange={(event) => setDeviceName(event.target.value)}
        />
        {message && <p role="alert">{getJoinMessage(message)}</p>}
        {joined && <p role="status">{t("Tudo certo! Abrindo seus canais…")}</p>}
        <button type="submit" className="brand-button" disabled={busy || !token || !name.trim()}>
          {t(busy ? "Entrando…" : "Entrar")}
        </button>
      </form>
    </main>
  )
}
