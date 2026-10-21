import type { ApiRoutes } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"
import { SettingsGroup } from "../../components/SettingsLayout"
import { userFacingError } from "../../errors"
import { t } from "../../i18n"
import "./work-access-settings.css"

type Session = ApiRoutes["GET /session"]["res"]
type Person = ApiRoutes["GET /people"]["res"]["people"][number]
type Invite = ApiRoutes["GET /invites"]["res"]["invites"][number]
type EmailConfiguration = ApiRoutes["GET /email"]["res"]["configuration"]
type Reachability = ApiRoutes["GET /public-address"]["res"]["reachability"]

type EmailDraft = {
  transport: "smtp" | "http"
  host: string
  port: string
  user: string
  password: string
  endpoint: string
  apiKey: string
  fromEmail: string
  fromName: string
  teamName: string
}

const emptyEmailDraft = (): EmailDraft => ({
  transport: "smtp",
  host: "",
  port: "587",
  user: "",
  password: "",
  endpoint: "",
  apiKey: "",
  fromEmail: "",
  fromName: "",
  teamName: "",
})

const getEmailDraft = (configuration: EmailConfiguration): EmailDraft => {
  const empty = emptyEmailDraft()
  if (!configuration) return empty
  return {
    ...empty,
    ...configuration,
    transport: configuration.transport,
    port: configuration.transport === "smtp" ? String(configuration.port) : empty.port,
  }
}

const getReachabilityHint = (reachability: Reachability): string => {
  if (reachability === "public") return t("Address looks public")
  if (reachability === "private") return t("Address is private")
  if (reachability === "localhost") return t("Address is local")
  if (reachability === "tailnet") return t("Address is tailnet")
  if (reachability === "invalid") return t("Address is invalid")
  return t("No public address")
}

const getRoleLabel = (role: Person["role"]): string => t(role === "admin" ? "Role admin" : "Role member")

export const WorkAccessSettings = ({ api }: { api: UiApi | undefined }) => {
  const [session, setSession] = useState<Session | null>(null)
  const [people, setPeople] = useState<Array<Person>>([])
  const [invites, setInvites] = useState<Array<Invite>>([])
  const [emailDraft, setEmailDraft] = useState(emptyEmailDraft)
  const [emailConfigured, setEmailConfigured] = useState(false)
  const [testRecipient, setTestRecipient] = useState("")
  const [publicAddress, setPublicAddress] = useState("")
  const [reachability, setReachability] = useState<Reachability>("unset")
  const [originReachability, setOriginReachability] = useState<Reachability>("unset")
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [copyLink, setCopyLink] = useState<string | null>(null)
  const [copyLinkInviteId, setCopyLinkInviteId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (!api) {
      setLoading(false)
      setError(t("People settings unavailable"))
      return
    }
    let active = true
    const load = async (): Promise<void> => {
      try {
        const signedIn = await api.request("GET /session", {})
        if (!active) return
        setSession(signedIn)
        const isAdmin = signedIn.person.role === "admin"
        if (!isAdmin) return
        const [peopleResult, inviteResult, emailResult, addressResult] = await Promise.all([
          api.request("GET /people", {}),
          api.request("GET /invites", {}),
          api.request("GET /email", {}),
          api.request("GET /public-address", {}),
        ])
        if (!active) return
        setPeople(peopleResult.people)
        setInvites(inviteResult.invites)
        setEmailDraft(getEmailDraft(emailResult.configuration))
        setEmailConfigured(emailResult.configured)
        setTestRecipient(emailResult.configuration?.fromEmail ?? "")
        setPublicAddress(addressResult.address ?? "")
        setReachability(addressResult.reachability)
        setOriginReachability(addressResult.requestOriginReachability)
      } catch (caught) {
        if (!active) return
        setError(userFacingError(caught) || t("People settings unavailable"))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [api])

  const refreshPeople = async (): Promise<void> => {
    if (!api) return
    const result = await api.request("GET /people", {})
    setPeople(result.people)
  }

  const saveEmail = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!api || busy) return
    setBusy("email")
    setError("")
    setStatus("")
    try {
      const common = {
        fromEmail: emailDraft.fromEmail,
        fromName: emailDraft.fromName,
        teamName: emailDraft.teamName,
      }
      const input: ApiRoutes["PUT /email"]["req"] =
        emailDraft.transport === "smtp"
          ? {
              ...common,
              transport: "smtp",
              host: emailDraft.host,
              port: Number(emailDraft.port),
              tls: true,
              user: emailDraft.user,
              password: emailDraft.password,
            }
          : {
              ...common,
              transport: "http",
              endpoint: emailDraft.endpoint,
              apiKey: emailDraft.apiKey,
            }
      const result = await api.request("PUT /email", input)
      setEmailDraft(getEmailDraft(result.configuration))
      setEmailConfigured(result.configured)
      setStatus(t("Email saved"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const removeEmail = async (): Promise<void> => {
    if (!api || busy) return
    setBusy("email")
    setError("")
    setStatus("")
    try {
      await api.request("DELETE /email", {})
      setEmailDraft(emptyEmailDraft())
      setEmailConfigured(false)
      setStatus(t("Email removed"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const sendTestEmail = async (): Promise<void> => {
    if (!api || busy || !testRecipient.trim()) return
    setBusy("test")
    setError("")
    setStatus("")
    try {
      await api.request("POST /email/test", { to: testRecipient.trim() })
      setStatus(t("Test email sent"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Test email failed"))
    } finally {
      setBusy(null)
    }
  }

  const saveAddress = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!api || busy) return
    setBusy("address")
    setError("")
    setStatus("")
    try {
      const result = await api.request("PUT /public-address", { address: publicAddress.trim() || null })
      setPublicAddress(result.address ?? "")
      setReachability(result.reachability)
      setStatus(t("Public address saved"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const createPairingCode = async (): Promise<void> => {
    if (!api || busy) return
    setBusy("pairing")
    setError("")
    setStatus("")
    try {
      const result = await api.request("POST /pairing-codes", {})
      setPairingCode(
        `${result.code} · ${t("Pairing code expires", { time: new Date(result.expiresAt).toLocaleTimeString() })}`,
      )
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const copyInviteLink = async (inviteId: string): Promise<void> => {
    if (!api || busy) return
    setBusy(`copy-${inviteId}`)
    setError("")
    setStatus("")
    try {
      const result = await api.request("GET /invites/:id/link", {}, { id: inviteId })
      setCopyLink(result.link)
      setCopyLinkInviteId(inviteId)
      if (!navigator.clipboard?.writeText) {
        setError(t("Could not copy link"))
        return
      }
      await navigator.clipboard.writeText(result.link)
      setStatus(t("Invite link copied"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not copy link"))
    } finally {
      setBusy(null)
    }
  }

  const resendInvite = async (invite: Invite): Promise<void> => {
    if (!api || busy) return
    setBusy(`resend-${invite.id}`)
    setError("")
    setStatus("")
    try {
      const result = await api.request("POST /invites/:id/resend", {}, { id: invite.id })
      setCopyLink(result.link)
      setCopyLinkInviteId(invite.id)
      setStatus(result.emailSent ? t("Invite resent") : t("Invite email not configured"))
      const listed = await api.request("GET /invites", {})
      setInvites(listed.invites)
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const revokeInvite = async (inviteId: string): Promise<void> => {
    if (!api || busy) return
    setBusy(`revoke-${inviteId}`)
    setError("")
    setStatus("")
    try {
      await api.request("DELETE /invites/:id", {}, { id: inviteId })
      setInvites((current) => current.filter((invite) => invite.id !== inviteId))
      setStatus(t("Invite revoked"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  const removePerson = async (person: Person): Promise<void> => {
    if (!api || busy || person.id === session?.person.id) return
    if (!window.confirm(t("Confirm remove person"))) return
    setBusy(`person-${person.id}`)
    setError("")
    setStatus("")
    try {
      await api.request("DELETE /people/:id", {}, { id: person.id })
      await refreshPeople()
      setStatus(t("Person removed"))
    } catch (caught) {
      setError(userFacingError(caught) || t("Could not save settings"))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p role="status">{t("Loading")}</p>
  if (!session) return <p role="alert">{error || t("People settings unavailable")}</p>

  const isAdmin = session.person.role === "admin"
  return (
    <div className="work-access-settings">
      {error && (
        <p className="work-access-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="work-access-status" role="status">
          {status}
        </p>
      )}

      {isAdmin && (
        <>
          <SettingsGroup title={t("Email delivery")}>
            <form className="work-access-form" onSubmit={(event) => void saveEmail(event)}>
              <label>
                {t("Email transport")}
                <select
                  value={emailDraft.transport}
                  onChange={(event) =>
                    setEmailDraft((draft) => ({ ...draft, transport: event.target.value as EmailDraft["transport"] }))
                  }
                >
                  <option value="smtp">{t("SMTP")}</option>
                  <option value="http">{t("Email API")}</option>
                </select>
              </label>
              {emailDraft.transport === "smtp" ? (
                <div className="work-access-fields">
                  <label>
                    {t("SMTP host")}
                    <input
                      autoComplete="off"
                      value={emailDraft.host}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, host: event.target.value }))}
                      required
                    />
                  </label>
                  <label>
                    {t("SMTP port")}
                    <input
                      inputMode="numeric"
                      value={emailDraft.port}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, port: event.target.value }))}
                      required
                    />
                  </label>
                  <label>
                    {t("SMTP user")}
                    <input
                      autoComplete="username"
                      value={emailDraft.user}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, user: event.target.value }))}
                    />
                  </label>
                  <label>
                    {t("SMTP password")}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={emailDraft.password}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, password: event.target.value }))}
                      placeholder={emailConfigured ? "••••••••" : ""}
                    />
                  </label>
                </div>
              ) : (
                <div className="work-access-fields">
                  <label>
                    {t("Email endpoint")}
                    <input
                      type="url"
                      autoComplete="url"
                      value={emailDraft.endpoint}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, endpoint: event.target.value }))}
                      required
                    />
                  </label>
                  <label>
                    {t("API key")}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={emailDraft.apiKey}
                      onChange={(event) => setEmailDraft((draft) => ({ ...draft, apiKey: event.target.value }))}
                      placeholder={emailConfigured ? "••••••••" : ""}
                    />
                  </label>
                </div>
              )}
              <div className="work-access-fields">
                <label>
                  {t("From email")}
                  <input
                    type="email"
                    autoComplete="email"
                    value={emailDraft.fromEmail}
                    onChange={(event) => setEmailDraft((draft) => ({ ...draft, fromEmail: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  {t("From name")}
                  <input
                    value={emailDraft.fromName}
                    onChange={(event) => setEmailDraft((draft) => ({ ...draft, fromName: event.target.value }))}
                    required
                  />
                </label>
                <label>
                  {t("Team name")}
                  <input
                    value={emailDraft.teamName}
                    onChange={(event) => setEmailDraft((draft) => ({ ...draft, teamName: event.target.value }))}
                    required
                  />
                </label>
              </div>
              <p className="work-access-note" role="status">
                {emailConfigured
                  ? t("Email is configured. Secrets are not shown again.")
                  : t("Email is not configured yet.")}
              </p>
              <button className="button button-primary" type="submit" disabled={busy !== null}>
                {busy === "email" ? t("Saving email settings…") : t("Save email settings")}
              </button>
              {emailConfigured && (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void removeEmail()}
                  disabled={busy !== null}
                >
                  {t("Remove email settings")}
                </button>
              )}
            </form>
            <div className="work-access-test-email">
              <label>
                {t("Test email recipient")}
                <input
                  type="email"
                  autoComplete="email"
                  value={testRecipient}
                  onChange={(event) => setTestRecipient(event.target.value)}
                />
              </label>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => void sendTestEmail()}
                disabled={!emailConfigured || busy !== null || !testRecipient.trim()}
              >
                {busy === "test" ? t("Sending test email…") : t("Send test email")}
              </button>
            </div>
          </SettingsGroup>

          <SettingsGroup title={t("Public address")}>
            <form className="work-access-form" onSubmit={(event) => void saveAddress(event)}>
              <p>{t("Public address help")}</p>
              <label>
                {t("Public address")}
                <input
                  type="url"
                  autoComplete="url"
                  value={publicAddress}
                  onChange={(event) => setPublicAddress(event.target.value)}
                  placeholder="https://equipe.example"
                />
              </label>
              <p className="work-access-note" role="status">
                {getReachabilityHint(reachability)} {t("Public address reachability help")}
              </p>
              {originReachability === "private" ||
              originReachability === "localhost" ||
              originReachability === "tailnet" ? (
                <p className="work-access-warning" role="status">
                  {t("Private origin warning")}
                </p>
              ) : null}
              <button className="button button-primary" type="submit" disabled={busy !== null}>
                {busy === "address" ? t("Saving public address…") : t("Save public address")}
              </button>
            </form>
          </SettingsGroup>
        </>
      )}

      <SettingsGroup title={t("People and devices")}>
        <div className="work-access-people">
          <button
            className="button button-quiet"
            type="button"
            onClick={() => void createPairingCode()}
            disabled={busy !== null}
          >
            {busy === "pairing" ? t("Creating pairing code…") : t("Pair new device")}
          </button>
          {pairingCode && (
            <p className="work-access-code" role="status">
              {pairingCode}
            </p>
          )}
          {isAdmin && (
            <>
              {people.length === 0 && <p>{t("No people yet")}</p>}
              {people.map((person) => (
                <article className="work-access-person" key={person.id}>
                  <div className="work-access-person-heading">
                    <div>
                      <strong>{person.name}</strong>
                      {person.email && <span>{person.email}</span>}
                    </div>
                    <span>{getRoleLabel(person.role)}</span>
                  </div>
                  <ul aria-label={t("Devices for {name}", { name: person.name })}>
                    {person.devices.map((device) => (
                      <li key={device.id}>
                        <span>{device.name}</span>
                        <time
                          dateTime={device.lastSeenAt === null ? undefined : new Date(device.lastSeenAt).toISOString()}
                        >
                          {device.lastSeenAt === null
                            ? t("Device not seen yet")
                            : t("Last seen {time}", { time: new Date(device.lastSeenAt).toLocaleString() })}
                        </time>
                      </li>
                    ))}
                  </ul>
                  {person.id !== session.person.id && (
                    <button
                      className="button button-quiet"
                      type="button"
                      onClick={() => void removePerson(person)}
                      disabled={busy !== null}
                    >
                      {t("Remove person")}
                    </button>
                  )}
                </article>
              ))}
            </>
          )}
        </div>
      </SettingsGroup>

      {isAdmin && (
        <SettingsGroup title={t("Pending invites")}>
          <div className="work-access-invites">
            {invites.filter((invite) => invite.status === "pending").length === 0 && <p>{t("No pending invites")}</p>}
            {invites
              .filter((invite) => invite.status === "pending")
              .map((invite) => (
                <article className="work-access-invite" key={invite.id}>
                  <div>
                    <strong>{invite.name}</strong>
                    <span>{invite.email}</span>
                  </div>
                  <time dateTime={new Date(invite.expiresAt).toISOString()}>
                    {t("Invite expires {date}", { date: new Date(invite.expiresAt).toLocaleString() })}
                  </time>
                  <div className="work-access-actions">
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => void resendInvite(invite)}
                      disabled={busy !== null}
                    >
                      {busy === `resend-${invite.id}` ? t("Resending invite…") : t("Resend invite")}
                    </button>
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => void copyInviteLink(invite.id)}
                      disabled={busy !== null}
                    >
                      {busy === `copy-${invite.id}` ? t("Copying invite link…") : t("Copy invite link")}
                    </button>
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => void revokeInvite(invite.id)}
                      disabled={busy !== null}
                    >
                      {t("Revoke invite")}
                    </button>
                  </div>
                  {copyLink && copyLinkInviteId === invite.id && (
                    <input
                      aria-label={t("Invite link ready to copy")}
                      readOnly
                      value={copyLink}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </article>
              ))}
          </div>
        </SettingsGroup>
      )}
    </div>
  )
}
