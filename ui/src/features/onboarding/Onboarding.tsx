import type { DiscoveredServer, OnboardingStatus } from "@touri/contracts"
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react"
import { createTauriInvoke, type TauriInvoke } from "../../api/client"
import { getWindowChrome, WindowFrame } from "../../components/WindowFrame"
import { t } from "../../i18n"
import { isNativeDesktop, serverModeError } from "../server/serverMode"
import {
  clearLocalSetup,
  completeOnboarding,
  createOnboardingRequest,
  getResumingLocalSetup,
  hasCompletedOnboarding,
  type OnboardingRequest,
  OnboardingUnsupportedError,
  scheduleLocalSetup,
} from "./client"
import "./onboarding.css"

type Step = "welcome" | "choose" | "connect" | "pair" | "here" | "access"
const nativeInvoke = createTauriInvoke()

export const OnboardingBoundary = ({
  children,
  invoke = nativeInvoke,
}: {
  children?: ReactNode
  invoke?: TauriInvoke | undefined
}) => {
  const [resuming] = useState(getResumingLocalSetup)
  const [open, setOpen] = useState(() => isNativeDesktop() && (resuming || !hasCompletedOnboarding()))
  const [revisit, setRevisit] = useState(resuming)
  const [request] = useState(() => createOnboardingRequest(invoke))
  useEffect(() => {
    if (!isNativeDesktop() || !open) return
    void invoke("server_mode_status", {})
      .then((status) => {
        if (status?.mode !== "server" || revisit) return
        completeOnboarding()
        setOpen(false)
      })
      .catch(() => undefined)
  }, [invoke, open, revisit])
  useEffect(() => {
    const show = () => {
      setRevisit(true)
      setOpen(true)
    }
    window.addEventListener("touri-open-onboarding", show)
    return () => window.removeEventListener("touri-open-onboarding", show)
  }, [])
  if (!open) return children

  const setup = (
    <Onboarding
      request={request}
      invoke={invoke}
      initialStep={getInitialStep(resuming, revisit)}
      onComplete={() => {
        completeOnboarding()
        if (resuming) clearLocalSetup()
        setOpen(false)
      }}
      revisiting={revisit}
      onUnsupported={() => setOpen(false)}
    />
  )
  const chrome = getWindowChrome({
    native: isNativeDesktop(),
    userAgent: navigator.userAgent,
    search: window.location.search,
  })
  if (chrome === "system") return setup
  return <WindowFrame>{setup}</WindowFrame>
}

export const Onboarding = ({
  request,
  invoke,
  onComplete,
  initialStep = "welcome",
  revisiting = false,
  onUnsupported,
}: {
  request: OnboardingRequest
  invoke: TauriInvoke
  onComplete: () => void
  initialStep?: Step
  revisiting?: boolean
  onUnsupported?: () => void
}) => {
  const [step, setStep] = useState<Step>(initialStep)
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [url, setUrl] = useState("")
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [remote, setRemote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState<{ url: string; code: string } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const discovery = useDiscovery(request, step === "connect" || step === "here", setStatus, status?.localUrl)
  const isMac = /Mac/i.test(navigator.platform)
  const computer = isMac ? "Mac" : "PC"
  useEffect(() => {
    const controller = new AbortController()
    void request("GET /onboarding", {}, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setStatus(next)
        setRemote(next.remoteUrl !== null)
        if (next.completed && !revisiting) onComplete()
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || revisiting) return
        // Existing runtimes can serve the workspace without desktop first-run routes.
        if (error instanceof OnboardingUnsupportedError) onUnsupported?.()
      })
    return () => controller.abort()
  }, [request, revisiting, onComplete, onUnsupported])
  // biome-ignore lint/correctness/useExhaustiveDependencies: move focus only when the screen changes.
  useEffect(() => {
    heading.current?.focus()
  }, [step])
  const go = (next: Step) => {
    setError(null)
    setCode("")
    setStep(next)
  }
  const start = async (configured: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await request("POST /onboarding", configured ? { name, email, remote } : { remote: false })
      if (result.url && remote) {
        const pairing = await request("POST /onboarding/pair-code", {})
        setAccess({ url: result.url, code: pairing.code })
        go("access")
        return
      }
      onComplete()
    } catch {
      setError(t(remote ? "setup.remoteError" : "setup.startError"))
    } finally {
      setBusy(false)
    }
  }
  const pair = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const destination = getServerUrl(url)
      if (isOwnRuntime(destination, status)) {
        setError(t("setup.ownRuntime"))
        return
      }
      const result = await invoke("server_mode_pair", { url: destination, code: code.trim() })
      if (result?.mode !== "server") throw new Error("SERVER_PAIR")
      onComplete()
    } catch (caught) {
      setError(serverModeError(caught))
    } finally {
      setCode("")
      setBusy(false)
    }
  }
  const runHere = async () => {
    setBusy(true)
    setError(null)
    try {
      const mode = await invoke("server_mode_status", {})
      if (mode?.mode !== "server") {
        go("here")
        return
      }
      scheduleLocalSetup()
      const result = await invoke("server_mode_local", {})
      if (result?.mode !== "local") throw new Error("SERVER_LOCAL")
      onComplete()
    } catch (caught) {
      clearLocalSetup()
      setError(serverModeError(caught))
    } finally {
      setBusy(false)
    }
  }
  const selectServer = (address: string) => {
    try {
      setUrl(getServerUrl(address))
      go("pair")
    } catch (caught) {
      setError(serverModeError(caught))
    }
  }
  return (
    <main className="setup-screen">
      <section className={`setup-card setup-${step}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
        {step !== "welcome" && (
          <button
            type="button"
            className="setup-back"
            disabled={busy}
            onClick={() => {
              if (step === "choose" && revisiting) {
                onComplete()
                return
              }
              go(getPreviousStep(step))
            }}
          >
            ← {t("Back")}
          </button>
        )}
        {step === "welcome" && (
          <WelcomeScreen
            heading={heading}
            id={id}
            status={status}
            busy={busy}
            onStart={() => void start(false)}
            onChoose={() => go("choose")}
          />
        )}
        {step === "choose" && (
          <ServerChooser
            heading={heading}
            id={id}
            computer={computer}
            busy={busy}
            onConnect={() => go("connect")}
            onHere={() => void runHere()}
          />
        )}
        {(step === "connect" || step === "pair") && (
          <ConnectScreen
            heading={heading}
            id={id}
            step={step}
            url={url}
            code={code}
            busy={busy}
            setUrl={setUrl}
            setCode={setCode}
            pair={pair}
            selectServer={selectServer}
            discovery={discovery}
          />
        )}
        {step === "here" && (
          <RunHereScreen
            heading={heading}
            id={id}
            computer={computer}
            status={status}
            busy={busy}
            name={name}
            email={email}
            remote={remote}
            setName={setName}
            setEmail={setEmail}
            setRemote={setRemote}
            discovery={discovery}
            invoke={invoke}
            onStart={() => void start(true)}
          />
        )}
        {step === "access" && access && (
          <>
            <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
              {t("setup.accessReady")}
            </h1>
            <p>{t("setup.phoneHelp")}</p>
            <p className="setup-access-url">{access.url}</p>
            <p>{t("setup.codeExpires")}</p>
            <output className="setup-pair-code">{access.code}</output>
            <button type="button" className="button button-brand setup-primary" onClick={onComplete}>
              {t("setup.openHome")}
            </button>
          </>
        )}
        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}

export const getServerUrl = (input: string) => {
  const url = getAddressUrl(input)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("SERVER_URL_INVALID")
  return url.origin
}

const getNetworkHelp = (state: OnboardingStatus["tailscale"] | undefined, searching: boolean) => {
  if (searching) return t("setup.checkingNetwork")
  if (state === "ready") return t("setup.networkReady")
  if (state === "missing") return t("setup.networkMissing")
  if (state === "signed-out") return t("setup.networkSignedOut")
  return t("setup.networkUnavailable")
}

const useDiscovery = (
  request: OnboardingRequest,
  enabled: boolean,
  setStatus: (update: (status: OnboardingStatus | null) => OnboardingStatus | null) => void,
  localUrl: string | undefined,
) => {
  const [servers, setServers] = useState<Array<DiscoveredServer>>([])
  const [searching, setSearching] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly restarts a canceled or completed search.
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setSearching(true)
    setServers((previous) => previous.filter((server) => server.source === "local"))
    const discover = async () => {
      const result = await request("GET /onboarding/servers", {}, controller.signal)
      if (controller.signal.aborted) return
      setStatus((previous) => (previous ? { ...previous, tailscale: result.tailscale } : null))
      const batches = Array.from({ length: Math.ceil(result.servers.length / 3) }, (_, index) =>
        result.servers.slice(index * 3, index * 3 + 3),
      )
      for (const batch of batches) {
        await Promise.all(
          batch.map(async (server) => {
            const found = await request("POST /onboarding/probe", { url: server.url }, controller.signal).catch(() => ({
              found: false,
            }))
            if (found.found && !controller.signal.aborted)
              setServers((previous) =>
                previous.some((existing) => existing.url === server.url) ? previous : [...previous, server],
              )
          }),
        )
        if (controller.signal.aborted) return
      }
    }
    void discover()
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })
    return () => controller.abort()
  }, [enabled, request, attempt, setStatus])
  useEffect(() => {
    if (!enabled || !localUrl) return
    const controller = new AbortController()
    void request("POST /onboarding/probe", { url: localUrl }, controller.signal)
      .then((result) => {
        if (!result.found || controller.signal.aborted) return
        const local: DiscoveredServer = { name: "", url: localUrl, source: "local" }
        setServers((previous) => (previous.some((server) => server.url === localUrl) ? previous : [local, ...previous]))
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [enabled, localUrl, request])
  return { servers, searching, retry: () => setAttempt((previous) => previous + 1) }
}

type HeadingProps = { heading: RefObject<HTMLHeadingElement | null>; id: string }
type DiscoveryState = { servers: Array<DiscoveredServer>; searching: boolean; retry: () => void }

const WelcomeScreen = ({
  heading,
  id,
  status,
  busy,
  onStart,
  onChoose,
}: HeadingProps & { status: OnboardingStatus | null; busy: boolean; onStart: () => void; onChoose: () => void }) => (
  <>
    <div className="setup-brand">
      <img src="/touri-bull.png" alt="" />
      <span>touri</span>
    </div>
    <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
      {t("setup.welcome")}
    </h1>
    <p className="setup-intro">{t("setup.welcomeDetail")}</p>
    {status?.hasData && <p className="setup-note">{t("setup.keepData")}</p>}
    <button type="button" className="button button-brand setup-primary" disabled={busy} onClick={onStart}>
      {t(busy ? "setup.starting" : "setup.localStart")} <span aria-hidden="true">→</span>
    </button>
    <p className="setup-note">{t("setup.noAccount")}</p>
    <button type="button" className="setup-server-link" disabled={busy} onClick={onChoose}>
      {t("setup.ownServer")} <span aria-hidden="true">›</span>
    </button>
  </>
)

const ServerChooser = ({
  heading,
  id,
  computer,
  busy,
  onConnect,
  onHere,
}: HeadingProps & { computer: string; busy: boolean; onConnect: () => void; onHere: () => void }) => (
  <>
    <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
      {t("setup.myServer")}
    </h1>
    <p className="setup-intro">{t("setup.serverDetail")}</p>
    <div className="setup-choices">
      <button type="button" className="setup-choice" disabled={busy} onClick={onConnect}>
        <span aria-hidden="true">↗</span>
        <strong>{t("setup.connectTitle")}</strong>
        <span>{t("setup.connectDetail")}</span>
        <span aria-hidden="true">→</span>
      </button>
      <button type="button" className="setup-choice" disabled={busy} onClick={onHere}>
        <span aria-hidden="true">⌂</span>
        <strong>{t("setup.runHere", { computer })}</strong>
        <span>{t("setup.runDetail")}</span>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  </>
)

const ConnectScreen = ({
  heading,
  id,
  step,
  url,
  code,
  busy,
  setUrl,
  setCode,
  pair,
  selectServer,
  discovery,
}: HeadingProps & {
  step: "connect" | "pair"
  url: string
  code: string
  busy: boolean
  setUrl: (url: string) => void
  setCode: (code: string) => void
  pair: () => Promise<void>
  selectServer: (url: string) => void
  discovery: DiscoveryState
}) => (
  <>
    <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
      {t("setup.connectTitle")}
    </h1>
    <p className="setup-intro">{t("setup.addressHelp")}</p>
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (step === "pair") void pair()
        else selectServer(url)
      }}
    >
      <label htmlFor={`${id}-url`}>{t("Endereço do servidor")}</label>
      <div className="setup-address">
        <input
          id={`${id}-url`}
          value={url}
          required
          autoComplete="url"
          spellCheck={false}
          maxLength={2048}
          placeholder="https://touri.example:8445"
          disabled={busy || step === "pair"}
          onChange={(event) => setUrl(event.target.value)}
        />
        {step === "connect" && (
          <button className="button button-brand" type="submit" disabled={!url.trim()}>
            {t("Conectar ao servidor")}
          </button>
        )}
      </div>
      {step === "pair" && (
        <>
          <p className="setup-note" id={`${id}-code-help`}>
            {t("setup.pairHelp")}
          </p>
          <label htmlFor={`${id}-code`}>{t("Código de pareamento")}</label>
          <input
            id={`${id}-code`}
            type="password"
            value={code}
            required
            autoComplete="off"
            maxLength={128}
            aria-describedby={`${id}-code-help`}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <p className="setup-note">{t("setup.pairPrivacy")}</p>
          <button className="button button-brand setup-primary" type="submit" disabled={busy || !code.trim()}>
            {t(busy ? "Aguarde…" : "setup.pair")}
          </button>
        </>
      )}
    </form>
    {step === "connect" && (
      <section className="setup-found" aria-label={t("setup.found")}>
        <h2>{t("setup.found")}</h2>
        <div aria-live="polite" aria-relevant="additions text">
          {discovery.servers.map((server) => (
            <div className="setup-server" key={server.url}>
              <span aria-hidden="true">{server.source === "local" ? "⌂" : "◎"}</span>
              <div>
                <strong>{server.source === "local" ? t("setup.thisComputer") : server.name}</strong>
                <p>{t(server.source === "local" ? "setup.runningHere" : "setup.tailnet")}</p>
              </div>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => selectServer(server.url)}
                aria-label={t("setup.useServer", {
                  name: server.source === "local" ? t("setup.thisComputer") : server.name,
                })}
              >
                {t("setup.use")}
              </button>
            </div>
          ))}
          {discovery.searching && <p role="status">{t("setup.searching")}</p>}
          {!discovery.searching && discovery.servers.length === 0 && <p>{t("setup.empty")}</p>}
        </div>
        <p className="setup-note">{t("setup.discoveryHelp")}</p>
        {!discovery.searching && (
          <button type="button" className="text-button" onClick={discovery.retry}>
            {t("setup.searchAgain")}
          </button>
        )}
      </section>
    )}
  </>
)

const RunHereScreen = ({
  heading,
  id,
  computer,
  status,
  busy,
  name,
  email,
  remote,
  setName,
  setEmail,
  setRemote,
  discovery,
  invoke,
  onStart,
}: HeadingProps & {
  computer: string
  status: OnboardingStatus | null
  busy: boolean
  name: string
  email: string
  remote: boolean
  setName: (name: string) => void
  setEmail: (email: string) => void
  setRemote: (remote: boolean) => void
  discovery: DiscoveryState
  invoke: TauriInvoke
  onStart: () => void
}) => (
  <>
    <h1 ref={heading} tabIndex={-1} id={`${id}-title`}>
      {t("setup.runHere", { computer })}
    </h1>
    <p className="setup-intro">{t("setup.builtIn")}</p>
    {status?.hasData && <p className="setup-callout">{t("setup.keepData")}</p>}
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onStart()
      }}
    >
      <div className="setup-identity">
        <label>
          {t("setup.name")}
          <input
            value={name}
            required
            maxLength={80}
            autoComplete="name"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t("setup.email")}
          <input
            value={email}
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
      </div>
      <p className="setup-note">{t("setup.teamIdentity")}</p>
      <label className="setup-toggle">
        <div>
          <strong>{t("setup.remote")}</strong>
          <p>{t("setup.remoteHelp")}</p>
        </div>
        <input
          type="checkbox"
          role="switch"
          aria-checked={remote}
          checked={remote}
          disabled={busy || status?.tailscale !== "ready"}
          onChange={(event) => setRemote(event.target.checked)}
          aria-describedby={`${id}-network-help`}
        />
      </label>
      <p className="setup-note" id={`${id}-network-help`}>
        {getNetworkHelp(status?.tailscale, discovery.searching)}
      </p>
      {!discovery.searching && (
        <button type="button" className="text-button" onClick={discovery.retry}>
          {t("onboarding.recheck")}
        </button>
      )}
      <p className="setup-note">{t("setup.agents")}</p>
      <p className="setup-note">{t("setup.alwaysOn")}</p>
      <p className="setup-note">
        {t("setup.migrate")}{" "}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void invoke("open_external", {
              url: "https://github.com/touri-ai/touri/blob/main/docs/moving-your-server.md",
            })
          }
        >
          {t("setup.guide")}
        </button>
      </p>
      <button type="submit" className="button button-brand setup-primary" disabled={busy}>
        {t(busy ? "setup.starting" : "setup.start")}
      </button>
    </form>
  </>
)

const getInitialStep = (resuming: boolean, revisiting: boolean): Step => {
  if (resuming) return "here"
  if (revisiting) return "choose"
  return "welcome"
}

const getPreviousStep = (step: Step): Step => {
  if (step === "choose") return "welcome"
  if (step === "pair") return "connect"
  return "choose"
}

const getAddressUrl = (input: string) => {
  try {
    return new URL(input.includes("://") ? input.trim() : `https://${input.trim()}`)
  } catch {
    throw new Error("SERVER_URL_INVALID")
  }
}

const isOwnRuntime = (destination: string, status: OnboardingStatus | null): boolean => {
  if (!status) return false
  if (status.remoteUrl && destination === getServerUrl(status.remoteUrl)) return true
  if (!status.runtimeUrl) return false
  const target = new URL(destination)
  const runtime = new URL(status.runtimeUrl)
  return ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.port === runtime.port
}
