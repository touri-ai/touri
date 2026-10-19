import type {
  ApiRoutes,
  Bot,
  BotFolder,
  DiscoveredProject,
  DoctorReport,
  EnvValue,
  MachineCapability,
  MachineState,
  ProcessSpec,
  Project,
  Routine,
  SecretMeta,
} from "@touri/contracts"
import { normalizeBotName } from "@touri/contracts"
import { avatarProfileFor } from "@touri/contracts/avatar"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { CREATE_PROVIDERS, useCreateProvider } from "../features/bots/useCreateProvider"
import { useCloudAccount } from "../features/cloud/useCloudAccount"
import { BOT_SETTINGS_SECTIONS, type BotSettingsSectionId, SETTINGS } from "../features/commandPalette/settingsRegistry"
import { useSettingFocus } from "../features/commandPalette/useSettingFocus"
import { ComputerGrantCard } from "../features/computer"
import { DoctorChecks } from "../features/doctor/DoctorChecks"
import { getBotJobId, type JobTemplate, NOT_SURE_JOB_ID } from "../features/jobs/catalog"
import { JobPicker } from "../features/jobs/JobPicker"
import { useIsServerMode } from "../features/server/serverMode"
import { accessLabel, fullAccessDescription, getHostLabel, plural, statusLabel, t } from "../i18n"
import { hostComputerSupported } from "../platform"
import { useHost } from "../useHost"
import type { WorkspaceActions } from "../useWorkspace"
import { ApiModelPicker } from "./ApiModelPicker"
import { type AvatarChoice, AvatarPicker } from "./AvatarPicker"
import { BotAccessSummary } from "./BotAccessSummary"
import { BotAvatar } from "./BotAvatar"
import { BotBrowserPicker } from "./BotBrowserPicker"
import { BotFolderSettings } from "./BotFolderSettings"
import { DeleteBotDialog } from "./DeleteBotDialog"
import { DeleteRoutineDialog } from "./DeleteRoutineDialog"
import { DiscoveredProjects } from "./DiscoveredProjects"
import { FolderPicker } from "./FolderPicker"
import { MachineFields } from "./MachineFields"
import { Modal } from "./Modal"
import { ProviderInstallation } from "./ProviderInstallation"
import { ProviderLogin } from "./ProviderLogin"
import { getBotProviderName, ProviderMark, providerName } from "./ProviderMark"
import { ProviderModelField } from "./ProviderModelField"
import { ProviderProfileFields } from "./ProviderProfileFields"
import { SecretsPanel } from "./RightPanels"
import { RoutineSchedule } from "./RoutineSchedule"
import { SettingsGroup, SettingsLayout, SettingsPane, SettingsRow, SettingsSwitch } from "./SettingsLayout"
import "./settings.css"

export { Modal } from "./Modal"
export { SettingsModal } from "./SettingsModal"

const BotMcpSettings = lazy(() => import("./BotMcpSettings").then((module) => ({ default: module.BotMcpSettings })))

const BotNetworkSettings = lazy(() =>
  import("./BotNetworkSettings").then((module) => ({ default: module.BotNetworkSettings })),
)

const BotStandingGrants = lazy(() =>
  import("./BotStandingGrants").then((module) => ({ default: module.BotStandingGrants })),
)

type DoctorModalProps = {
  api: UiApi
  doctor: DoctorReport | null
  doctorError: string | null
  onRefresh: () => Promise<void>
  onClose: () => void
  onImport: () => void
  launchAtLogin: boolean
  onLaunchAtLogin: (value: boolean) => Promise<void>
  focusSetting?: string | null
}

export const DoctorModal = ({
  api,
  doctor,
  doctorError,
  onRefresh,
  onClose,
  onImport,
  launchAtLogin,
  onLaunchAtLogin,
  focusSetting,
}: DoctorModalProps) => {
  useSettingFocus(focusSetting)
  return (
    <Modal onClose={onClose} title={t("Doctor")} eyebrow="ambiente do touri" className="settings-modal doctor-modal">
      <div className="doctor-modal-content">
        <p className="modal-intro">
          {t("touri uses local CLIs or isolated Linux machines. Host login in a VM requires per-bot opt-in.")}
        </p>
        <DoctorChecks api={api} doctor={doctor} error={doctorError} onRefresh={onRefresh} />
        <div className="onboarding-options">
          <label
            className="toggle-row"
            htmlFor={SETTINGS.launchAtLogin.controlId}
            data-setting-id={SETTINGS.launchAtLogin.id}
          >
            <span>
              <strong>{SETTINGS.launchAtLogin.label}</strong>
              <small>{SETTINGS.launchAtLogin.description}</small>
            </span>
            <SettingsSwitch
              id={SETTINGS.launchAtLogin.controlId}
              checked={launchAtLogin}
              onChange={(event) => void onLaunchAtLogin(event.target.checked)}
            />
          </label>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="button button-quiet" onClick={onClose}>
          {t("Done")}
        </button>
        <button type="button" className="button button-dark" onClick={onImport}>
          {t("Import legacy app bots")}
        </button>
      </div>
    </Modal>
  )
}

type ImportWizardProps = { bots: Array<Bot>; api: UiApi; onClose: () => void; onNotice: (message: string) => void }

export const ImportWizard = ({ bots, api, onClose, onNotice }: ImportWizardProps) => {
  const [step, setStep] = useState(0)
  const [root, setRoot] = useState("")
  const [selected, setSelected] = useState(() => bots.map((bot) => bot.id))
  const [importCodexSessions, setImportCodexSessions] = useState(false)
  const [report, setReport] = useState<ApiRoutes["GET /imports/:id"]["res"]["report"]>(null)
  const [busy, setBusy] = useState(false)

  const run = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    try {
      const response = await api.request("POST /imports/legacy", {
        source: { kind: "local", root },
        botIds: selected,
        importCodexSessions,
        cwdMap: [],
        includeAttachments: true,
        dryRun,
      })
      const status = await api.request("GET /imports/:id", {}, { id: response.importId })
      setReport(status.report)
      setStep(dryRun ? 2 : 3)
      onNotice(
        dryRun ? t("Dry run complete. Nothing was written.") : t("Import complete. Imported routines stay disabled."),
      )
    } catch {
      onNotice(t("The import adapter is unavailable."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} title={t("Import your teammates")} eyebrow={t("Import step", { step: step + 1 })}>
      <div className="wizard-steps">
        {[t("Source"), t("Choose bots"), t("Dry run"), t("Import"), t("Cut-over")].map((label, index) => (
          <span className={index === step ? "wizard-active" : index < step ? "wizard-done" : ""} key={label}>
            <i>{index + 1}</i>
            {label}
          </span>
        ))}
      </div>
      {step === 0 && (
        <div className="wizard-content">
          <h3>{t("Bring over a local archive")}</h3>
          <p>
            {t(
              "touri reads only the allowlisted bots, workspaces, attachments and message snapshot. Credentials and browser state are never opened.",
            )}
          </p>
          <label className="field-label" htmlFor="legacy-root">
            {t("legacy app root")}
          </label>
          <input id="legacy-root" value={root} onChange={(event) => setRoot(event.target.value)} />
          <div className="info-callout">
            {t("Default source: local path. SSH import is available when the sidecar transport is connected.")}
          </div>
          <button type="button" className="button button-dark wizard-next" onClick={() => setStep(1)}>
            {t("Continue")}
            <span>→</span>
          </button>
        </div>
      )}
      {step === 1 && (
        <div className="wizard-content">
          <h3>{t("Select bots and map their workspaces")}</h3>
          <div className="bot-picker">
            {bots.map((bot) => (
              <label className="picker-row" key={bot.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(bot.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id),
                    )
                  }
                />
                <BotAvatar bot={bot} size={32} />
                <span>
                  <strong>{bot.name}</strong>
                  <small>{t("existing local bot")}</small>
                </span>
                <em>{bot.provider}</em>
              </label>
            ))}
          </div>
          <label className="toggle-row import-warning">
            <span>
              <strong>{t("Copy native Codex sessions")}</strong>
              <small>{t("Rollouts can contain raw tool output. Leave off to continue from history.")}</small>
            </span>
            <input
              type="checkbox"
              checked={importCodexSessions}
              onChange={(event) => setImportCodexSessions(event.target.checked)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={() => setStep(0)}>
              {t("Back")}
            </button>
            <button
              type="button"
              className="button button-dark"
              disabled={selected.length === 0}
              onClick={() => setStep(2)}
            >
              {t("Review import")}
            </button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="wizard-content">
          <h3>{t("Review a safe dry run")}</h3>
          <p>
            {t("We’ll compare source records, repair dropped-message branches, and report exactly what would change.")}
          </p>
          <div className="review-grid">
            <span>
              {t("Selected bots")}
              <strong>{selected.length}</strong>
            </span>
            <span>
              {t("Attachments")}
              <strong>{t("included")}</strong>
            </span>
            <span>
              {t("Sessions")}
              <strong>{importCodexSessions ? "copy" : t("history only")}</strong>
            </span>
          </div>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={() => setStep(1)}>
              {t("Back")}
            </button>
            <button type="button" className="button button-outline" disabled={busy} onClick={() => void run(true)}>
              {busy ? t("Checking…") : t("Run dry run")}
            </button>
            <button type="button" className="button button-brand" disabled={busy} onClick={() => void run(false)}>
              {t("Import now")}
            </button>
          </div>
          {report && <ImportReportView report={report} />}
        </div>
      )}
      {step === 3 && (
        <div className="wizard-content">
          <h3>{t("Import finished")}</h3>
          <div className="success-card">
            <span>✓</span>
            <div>
              <strong>{t("History is in touri")}</strong>
              <p>
                {t("Import counts", { messages: report?.messages.created ?? 0, threads: report?.threads.created ?? 0 })}
              </p>
            </div>
          </div>
          {report && <ImportReportView report={report} />}
          <button type="button" className="button button-dark wizard-next" onClick={() => setStep(4)}>
            {t("Show cut-over checklist")}
            <span>→</span>
          </button>
        </div>
      )}
      {step === 4 && (
        <div className="wizard-content">
          <h3>{t("Cut over when you’re ready")}</h3>
          <ol className="checklist">
            <li>
              <span>1</span>
              {t("Verify your imported thread and message counts.")}
            </li>
            <li>
              <span>2</span>
              {t("Disable legacy app routines on the source machine.")}
            </li>
            <li>
              <span>3</span>
              {t("Run one final import, then enable routines here.")}
            </li>
            <li>
              <span>4</span>
              {t("Turn on launch at login so scheduled work stays local.")}
            </li>
          </ol>
          <button type="button" className="button button-dark wizard-next" onClick={onClose}>
            {t("Start using touri")}
            <span>→</span>
          </button>
        </div>
      )}
    </Modal>
  )
}

const ImportReportView = ({ report }: { report: ApiRoutes["GET /imports/:id"]["res"]["report"] }) =>
  report ? (
    <div className="import-report">
      <strong>{t("Report")}</strong>
      <div>
        <span>
          {plural(report.bots.created, "bot", "bots")} <b>{report.bots.created}</b>
        </span>
        <span>
          {plural(report.threads.created, "conversa", "conversas")}
          <b>{report.threads.created}</b>
        </span>
        <span>
          {plural(report.messages.created, "mensagem", "mensagens")}
          <b>{report.messages.created}</b>
        </span>
        <span>
          {plural(report.routines.created, "rotina", "rotinas")}
          <b>{report.routines.created}</b>
        </span>
      </div>
      {report.warnings.map((warning) => (
        <small key={warning}>⚠ {warning}</small>
      ))}
    </div>
  ) : null

export const BotModelModal = ({
  api,
  bot,
  onSave,
  onClose,
}: {
  api: UiApi
  bot: Bot
  onSave: (model: string | null) => Promise<void>
  onClose: () => void
}) => {
  const [model, setModel] = useState(bot.model ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (!saving) onClose()
  }
  return (
    <Modal onClose={close} title={t("Choose model")} eyebrow={getBotProviderName(bot)}>
      <form
        className="modal-form"
        onSubmit={async (event) => {
          event.preventDefault()
          if (saving) return
          setSaving(true)
          setError(null)
          try {
            await onSave(model.trim() || null)
            onClose()
          } catch (error) {
            setError(userFacingError(error))
          } finally {
            setSaving(false)
          }
        }}
      >
        <p>{t("Choose the model for this bot’s next messages.")}</p>
        <label htmlFor="composer-model">{t("Model")}</label>
        <ProviderModelField
          id="composer-model"
          api={api}
          botId={bot.id}
          provider={bot.provider}
          value={model}
          onChange={setModel}
          picker
          disabled={saving}
        />
        {error && <p role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button-quiet" onClick={close} disabled={saving}>
            {t("Cancel")}
          </button>
          <button type="submit" className="button button-brand" disabled={saving} aria-busy={saving}>
            {t("Save model")}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// VM projects copy a Git commit; a selected host folder still needs its own grant.
const projectFolderPatch = (
  folders: BotFolder[],
  folder: BotFolder,
  machine: Bot["machine"],
): { folders?: BotFolder[] } =>
  machine !== "vm" && folder.access === "read-write" && !folders.some((item) => item.path === folder.path)
    ? {}
    : { folders: [...folders.filter((item) => item.path !== folder.path), folder] }

type BotCreateModalProps = {
  bots?: Bot[]
  initialJob?: JobTemplate | null
  api?: UiApi
  invokeCommand?: TauriInvoke
  cloudEnabled?: boolean
  capability?: MachineCapability
  projects?: Array<Project>
  onCreateProject?: WorkspaceActions["createProject"]
  onClose: () => void
  onCreate: (input: ApiRoutes["POST /bots"]["req"], loginDraftId?: string) => Promise<void>
}

export const BotCreateModal = ({
  bots = [],
  initialJob,
  capability,
  projects = [],
  onClose,
  onCreate,
  onCreateProject,
  api,
  invokeCommand,
  cloudEnabled = false,
}: BotCreateModalProps) => {
  const { account: cloudAccount } = useCloudAccount(api, cloudEnabled)
  const [cloudApiKey, setCloudApiKey] = useState("")
  const [avatarSeed] = useState(() => crypto.randomUUID())
  const [avatar, setAvatar] = useState<AvatarChoice>(() => {
    const profile = avatarProfileFor({ id: avatarSeed, color: null })
    return { avatarShape: profile.shape, color: profile.color }
  })
  const [name, setName] = useState("")
  const [roleLine, setRoleLine] = useState(initialJob?.roleLine ?? "")
  const [title, setTitle] = useState("")
  const [loginDraftId] = useState(() => `draft-${crypto.randomUUID()}`)
  const fallbackHost = useHost(api)
  const login = useCreateProvider(api, loginDraftId)
  const host = login.flow?.hostKind ?? login.flow?.host ?? fallbackHost
  const [apiModel, setApiModel] = useState("")
  const provider = apiModel ? "opencode" : login.provider
  const [jobId, setJobId] = useState(initialJob?.id ?? NOT_SURE_JOB_ID)
  const [advanced, setAdvanced] = useState(false)
  const [instructions, setInstructions] = useState(initialJob?.instructions ?? "")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<Bot["reasoningEffort"]>(null)
  const [projectId, setProjectId] = useState("")
  const [addingProject, setAddingProject] = useState(false)
  const [pickingProject, setPickingProject] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [addedProjects, setAddedProjects] = useState<Project[]>([])
  const availableProjects = [
    ...projects,
    ...addedProjects.filter((item) => !projects.some((project) => project.id === item.id)),
  ].filter((project) => !project.archivedAt)
  const [folders, setFolders] = useState<BotFolder[]>([])
  const [anyFolderAccess, setAnyFolderAccess] = useState(false)
  const [browserEnabled, setBrowserEnabled] = useState(true)
  const [browser, setBrowser] = useState<Bot["browser"]>("touri")
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState("workspace-write")
  const [machine, setMachine] = useState<
    Pick<Bot, "machine" | "machineIdleMinutes" | "vmProviderLogin" | "hostComputerUse">
  >({ machine: "local", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false })
  const [saving, setSaving] = useState(false)
  const signInRef = useRef<HTMLElement>(null)
  // A signed-in account is used by default; "Use another account" opens the same chooser as first sign-in.
  const [choosingAccount, setChoosingAccount] = useState(false)
  const showAccountChoice = (): void => {
    setChoosingAccount(true)
    requestAnimationFrame(() => signInRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus())
  }
  const chooseProvider = (next: Bot["provider"]): void => {
    setError(null)
    setApiModel("")
    setModel("")
    setEffort(null)
    setMachine((current) => ({ ...current, vmProviderLogin: false }))
    void login.selectProvider(next)
  }
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!name.trim() || saving || projectBusy) return
    const validName = normalizeBotName(name)
    if (!validName) {
      setError(t("Use de 1 a 80 caracteres, sem quebras de linha ou caracteres de controle."))
      return
    }
    if (api && !apiModel && machine.machine !== "cloud" && (!login.ready || login.checking)) {
      setError(
        t(login.flow?.executable === "missing" ? "onboarding.installFirst" : "Sign in above before creating your bot."),
      )
      signInRef.current?.focus()
      return
    }
    if (invalidMachine) {
      setAdvanced(true)
      setError(t("Choose 1 to 1,440 idle minutes."))
      return
    }
    if (machine.machine === "cloud" && !cloudApiKey.trim()) {
      setAdvanced(true)
      setError(t("Enter the API key above before creating your bot."))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input = {
        name: validName,
        roleLine: roleLine.trim() || null,
        title: title.trim() || null,
        provider,
        instructions,
        model: apiModel || model.trim() || null,
        reasoningEffort: effort,
        projectId: machine.machine === "cloud" ? null : projectId || null,
        folders: machine.machine === "cloud" ? [] : folders,
        anyFolderAccess: machine.machine !== "cloud" && anyFolderAccess,
        browserEnabled,
        browser,
        access: access === "full-approved" ? ("full" as const) : (access as Bot["access"]),
        approvals:
          access === "full" || (provider === "codex" && access === "full-approved")
            ? ("never" as const)
            : ("on-request" as const),
        avatarSeed,
        ...avatar,
        ...machine,
        ...(machine.machine === "cloud" ? { cloudApiKey } : {}),
      }
      if (api && !apiModel && machine.machine !== "cloud") await onCreate(input, loginDraftId)
      else await onCreate(input)
      onClose()
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      setSaving(false)
    }
  }
  const addProject = async (input: ApiRoutes["POST /projects"]["req"], folder?: BotFolder) => {
    if (!api) return
    setProjectBusy(true)
    try {
      const project = onCreateProject
        ? await onCreateProject(input)
        : (await api.request("POST /projects", input)).project
      setAddedProjects((current) => [...current.filter((item) => item.id !== project.id), project])
      setProjectId(project.id)
      if (folder)
        setFolders(
          (current) =>
            projectFolderPatch(current, { ...folder, path: project.path }, machine.machine).folders ?? current,
        )
      setAddingProject(false)
    } finally {
      setProjectBusy(false)
    }
  }
  const invalidMachine =
    machine.machine === "vm" &&
    (!Number.isInteger(machine.machineIdleMinutes) ||
      machine.machineIdleMinutes < 1 ||
      machine.machineIdleMinutes > 1440)
  return (
    <Modal
      onClose={() => {
        if (!saving && !projectBusy) onClose()
      }}
      title={t("Create a teammate")}
      eyebrow={t("New bot")}
      className="settings-modal bot-create-modal"
    >
      <form className="bot-create-form" onSubmit={(event) => void submit(event)}>
        <div className="bot-create-content">
          <fieldset className="bot-create-draft" disabled={saving}>
            <div className="bot-create-main">
              <div className="bot-create-fields">
                <label htmlFor="bot-name">{t("Name")}</label>
                <input
                  id="bot-name"
                  required
                  data-initial-focus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t("e.g. dev")}
                />
                <JobPicker
                  value={jobId}
                  coveredJobIds={bots
                    .filter((bot) => !bot.archivedAt)
                    .flatMap((bot) => {
                      const jobId = getBotJobId(bot)

                      return jobId ? [jobId] : []
                    })}
                  onChange={(job) => {
                    setJobId(job?.id ?? NOT_SURE_JOB_ID)
                    setRoleLine(job?.roleLine ?? "")
                    setInstructions(job?.instructions ?? "")
                  }}
                />
              </div>
              <AvatarPicker
                label={t("Mascot")}
                name={name}
                bot={{ id: avatarSeed, avatarSeed, ...avatar }}
                onChange={(choice) => setAvatar((current) => ({ ...current, ...choice }))}
              />
            </div>
            <div className="bot-create-defaults" aria-live="polite">
              {!apiModel &&
                machine.machine !== "cloud" &&
                (login.checking ? (
                  <p>{t("onboarding.checking", { host: getHostLabel(host) })}</p>
                ) : (
                  login.ready && (
                    <>
                      <p>
                        {t("onboarding.uses", {
                          provider: providerName(provider),
                          host: getHostLabel(host),
                        })}
                      </p>
                      {!choosingAccount && (
                        <button type="button" className="text-button" onClick={showAccountChoice}>
                          {t("Use another account")}
                        </button>
                      )}
                    </>
                  )
                ))}
              <BotAccessSummary
                host={host}
                machine={machine.machine}
                access={access === "full-approved" ? "full" : (access as Bot["access"])}
                approvals={
                  access === "full" || (provider === "codex" && access === "full-approved") ? "never" : "on-request"
                }
                folders={folders}
                anyFolderAccess={anyFolderAccess}
              />
            </div>
            {machine.machine !== "cloud" && (
              <ApiModelPicker
                api={api}
                id="create-api-model"
                value={apiModel}
                disabled={saving}
                onChange={(value) => {
                  setApiModel(value)
                  setModel("")
                  setEffort(null)
                  setError(null)
                }}
              />
            )}
            {api &&
              !apiModel &&
              machine.machine !== "cloud" &&
              (choosingAccount || (!login.checking && !login.ready)) && (
                <section ref={signInRef} tabIndex={-1} className="bot-create-login" aria-label={t("Choose an account")}>
                  <p>
                    {t(
                      login.checking || login.ready
                        ? "Choose the account this bot will use."
                        : login.flow?.executable === "missing"
                          ? "onboarding.installFirst"
                          : "Sign in to an account to create your bot.",
                    )}
                  </p>
                  <div className="bot-create-accounts">
                    {CREATE_PROVIDERS.map((candidate) => (
                      <button
                        type="button"
                        key={candidate}
                        className="button button-quiet"
                        aria-pressed={provider === candidate}
                        onClick={() => chooseProvider(candidate)}
                      >
                        {providerName(candidate)}
                      </button>
                    ))}
                  </div>
                  {login.checking || login.ready ? null : login.flow?.executable === "missing" ? (
                    <ProviderInstallation
                      provider={provider}
                      host={host}
                      busy={login.checking}
                      onRecheck={() => {
                        setError(null)
                        void login.selectProvider(provider).then(() => document.getElementById("bot-name")?.focus())
                      }}
                    />
                  ) : !login.error ? (
                    <ProviderLogin
                      key={provider}
                      api={api}
                      botId={loginDraftId}
                      provider={provider}
                      onConfigured={() => {}}
                      onReadyChange={(ready) => {
                        login.setReady(ready)
                        if (ready) setError(null)
                      }}
                    />
                  ) : null}
                </section>
              )}
            {!apiModel && login.error && !login.checking && machine.machine !== "cloud" && !login.ready && (
              <div className="warning-callout">
                <p role="alert">{login.error}</p>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => void login.selectProvider(provider)}
                >
                  {t("onboarding.recheck")}
                </button>
              </div>
            )}
            <button
              type="button"
              className="text-button bot-create-advanced-toggle"
              aria-expanded={advanced}
              aria-controls="bot-create-advanced"
              onClick={() => setAdvanced((open) => !open)}
            >
              {t("Advanced")} <span aria-hidden="true">{advanced ? "−" : "+"}</span>
            </button>
            {advanced && (
              <div id="bot-create-advanced" className="bot-create-fields bot-create-advanced">
                {machine.machine !== "cloud" && (
                  <>
                    <label htmlFor="create-project">{t("Projeto")}</label>
                    <select
                      id="create-project"
                      disabled={projectBusy}
                      value={projectId}
                      onChange={(event) => {
                        if (event.target.value === "__add_project__") {
                          setAddingProject(true)
                          return
                        }

                        setProjectId(event.target.value)
                        setAddingProject(false)
                      }}
                    >
                      <option value="">{t("Nenhum projeto (começa na pasta do bot)")}</option>
                      {availableProjects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                      <option value="__add_project__" disabled={!api}>
                        {t("Adicionar projeto…")}
                      </option>
                    </select>
                    {addingProject && api && (
                      <DiscoveredProjects
                        api={api}
                        disabled={saving}
                        onSelect={(repository) => addProject({ path: repository.path, name: repository.name })}
                        onChooseFolder={async () => setPickingProject(true)}
                      />
                    )}
                    <BotFolderSettings
                      api={api}
                      readOnly={access === "read-only"}
                      fullAccess={access === "full" || access === "full-approved"}
                      folders={folders}
                      anyFolderAccess={anyFolderAccess}
                      machine={machine.machine}
                      disabled={saving}
                      invokeCommand={invokeCommand}
                      onFolders={setFolders}
                      onAnyFolderAccess={setAnyFolderAccess}
                    />
                    {pickingProject && api && (
                      <FolderPicker
                        api={api}
                        invokeCommand={invokeCommand}
                        onClose={() => setPickingProject(false)}
                        onSelect={async (folder) => {
                          await addProject({ path: folder.path }, folder)
                          setPickingProject(false)
                        }}
                      />
                    )}
                  </>
                )}
                <label htmlFor="bot-role">{t("Função")}</label>
                <input
                  id="bot-role"
                  value={roleLine}
                  onChange={(event) => setRoleLine(event.target.value)}
                  aria-describedby="bot-role-help"
                />
                <small id="bot-role-help" className="field-help">
                  {t("A summary of the bot’s work, e.g. research and compare sources.")}
                </small>
                <label htmlFor="bot-title">{t("Título (opcional)")}</label>
                <input
                  id="bot-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  aria-describedby="bot-title-help"
                />
                <small id="bot-title-help" className="field-help">
                  {t("A short label for the bot, e.g. Researcher. Detailed tasks go in the instructions.")}
                </small>
                <label htmlFor="create-instructions">{t("Bot instructions")}</label>
                <textarea
                  id="create-instructions"
                  rows={5}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder={t("Describe this bot’s role, tasks and style.")}
                  aria-describedby="create-instructions-help"
                />
                <small id="create-instructions-help" className="field-help">
                  {t("Detailed guidance for the bot. Saved as SOUL.md in the bot’s folder.")}
                </small>
                {!apiModel && (
                  <>
                    <label htmlFor="bot-provider">{t("Provider")}</label>
                    <select
                      id="bot-provider"
                      value={provider}
                      onChange={(event) => chooseProvider(event.target.value as Bot["provider"])}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude Code</option>
                      <option value="opencode">OpenCode</option>
                    </select>
                    <label htmlFor="create-model">{t("Model")}</label>
                    <ProviderMark provider={provider} />
                    <ProviderModelField
                      id="create-model"
                      api={api}
                      provider={provider}
                      value={model}
                      onChange={setModel}
                    />
                    <label htmlFor="create-effort">{t("Reasoning")}</label>
                    <select
                      id="create-effort"
                      value={effort ?? ""}
                      onChange={(event) => setEffort((event.target.value || null) as Bot["reasoningEffort"])}
                    >
                      <option value="">{t("Padrão do provedor")}</option>
                      <option value="low">{t("Low")}</option>
                      <option value="medium">{t("Medium")}</option>
                      <option value="high">{t("High")}</option>
                      <option value="xhigh">{t("Extra high")}</option>
                    </select>
                  </>
                )}
                <label htmlFor="bot-access">{t("Access")}</label>
                <select
                  id="bot-access"
                  value={provider === "codex" && access === "full-approved" ? "full" : access}
                  onChange={(event) => setAccess(event.target.value as Bot["access"])}
                >
                  <option value="read-only">{t("Read-only")}</option>
                  <option value="workspace-write">{t("Workspace write · approvals")}</option>
                  <option value="full">{t("Full access")}</option>
                  {provider !== "codex" && <option value="full-approved">{t("Acesso total com aprovação")}</option>}
                </select>
                {(access === "full" || access === "full-approved") && (
                  <div className="warning-callout">
                    {fullAccessDescription({
                      machine: machine.machine,
                      approvals:
                        access === "full" || (provider === "codex" && access === "full-approved")
                          ? "never"
                          : "on-request",
                    })}
                  </div>
                )}
                <label className="toggle-row" htmlFor="create-browser">
                  <span>{t("Browser enabled")}</span>
                  <SettingsSwitch
                    id="create-browser"
                    checked={browserEnabled}
                    onChange={(event) => setBrowserEnabled(event.target.checked)}
                  />
                </label>
                <BotBrowserPicker value={browser} machine={machine.machine} disabled={saving} onChange={setBrowser} />
                <MachineFields
                  values={machine}
                  cloudConnected={cloudAccount?.connected === true}
                  provider={provider}
                  {...(capability ? { capability } : {})}
                  onChange={(patch) => {
                    setMachine((current) => ({ ...current, ...patch }))
                    if (patch.machine === "cloud") {
                      setProjectId("")
                      setApiModel("")
                    }
                    if (patch.machine)
                      setBrowser((current) =>
                        patch.machine === "vm"
                          ? "machine"
                          : current === "machine" || patch.machine === "cloud"
                            ? "touri"
                            : current,
                      )
                  }}
                />
                {machine.machine === "cloud" && (
                  <>
                    <label htmlFor="cloud-api-key">
                      {t("API key for {name}", {
                        name: provider === "opencode" ? "OpenRouter" : provider === "codex" ? "OpenAI" : "Anthropic",
                      })}
                    </label>
                    <input
                      id="cloud-api-key"
                      type="password"
                      autoComplete="off"
                      value={cloudApiKey}
                      onChange={(event) => setCloudApiKey(event.target.value)}
                    />
                    <p className="field-help">
                      {t(
                        "The bot runs in the connected cloud service with your own API key. Usage is billed by that service.",
                      )}
                    </p>
                  </>
                )}
                {invalidMachine && (
                  <p role="alert" className="warning-callout">
                    {t("Choose 1 to 1,440 idle minutes.")}
                  </p>
                )}
                <p>{t("Connect tools after creating this bot, in its advanced settings.")}</p>
              </div>
            )}
          </fieldset>
        </div>
        {error && (
          <p className="warning-callout bot-create-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button button-quiet" disabled={saving || projectBusy} onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="button button-brand"
            disabled={
              !name.trim() ||
              saving ||
              projectBusy ||
              invalidMachine ||
              (machine.machine === "cloud" && !cloudApiKey.trim()) ||
              (!apiModel && machine.machine !== "cloud" && login.checking)
            }
          >
            {saving ? t("Creating…") : t("Create teammate")}
          </button>
        </div>
      </form>
    </Modal>
  )
}

type BotSettingsModalProps = {
  settings?: ApiRoutes["GET /settings"]["res"]["settings"] | null
  invokeCommand?: TauriInvoke
  bots?: Bot[]

  initialSection?: BotSettingsSectionId | undefined
  /** Registry setting id to focus and highlight once the dialog opens (command palette). */
  focusSetting?: string | null
  focusMcp?: boolean
  permissionsOnly?: boolean

  api?: UiApi

  capability?: MachineCapability
  machineState?: MachineState | undefined
  activeTurns?: boolean
  onOpenIntegrations?: () => void
  onOpenRoutines?: () => void
  bot: Bot
  projects: Array<Project>
  routines: Array<Routine>
  actions: WorkspaceActions
  onAttachFile?: (() => void) | undefined
  onClose: () => void
}

export const BotSettingsModal = ({
  settings,
  invokeCommand,
  bots,
  focusMcp = false,
  permissionsOnly = false,
  api,
  bot,
  projects,
  routines,
  actions,
  onClose,
  onAttachFile,
  capability,
  machineState,
  activeTurns = false,
  onOpenIntegrations,
  onOpenRoutines,
  initialSection,
  focusSetting,
}: BotSettingsModalProps) => {
  const host = useHost(api)
  const serverMode = useIsServerMode()
  const routinesFocusRef = useRef<HTMLElement | null>(null)
  const [deletingRoutine, setDeletingRoutine] = useState<Routine | null>(null)
  const [vmMemory, setVmMemory] = useState(settings?.botVmMemoryMb ?? 1536)
  const [name, setName] = useState(bot.name)
  // Only the parts the user changes are saved, so a rename never rewrites a stored look.
  const [avatar, setAvatar] = useState<Partial<AvatarChoice>>({})
  const [roleLine, setRoleLine] = useState(bot.roleLine ?? "")
  const [title, setTitle] = useState(bot.title ?? "")
  const [deleting, setDeleting] = useState(false)
  const [instructions, setInstructions] = useState(bot.instructions)
  const [machineChanges, setMachine] = useState<
    Partial<Pick<Bot, "machine" | "machineIdleMinutes" | "vmProviderLogin" | "hostComputerUse">>
  >({})
  // Login may finish after this dialog opens. Keep untouched fields live and
  // omit them from PATCH so an unrelated save cannot revoke a newer login.
  const machine = {
    machine: bot.machine,
    machineIdleMinutes: bot.machineIdleMinutes,
    vmProviderLogin: bot.vmProviderLogin,
    hostComputerUse: bot.hostComputerUse,
    ...machineChanges,
  }
  const [browser, setBrowser] = useState(bot.browser ?? "touri")
  const [provider, setProvider] = useState(bot.provider)
  const [model, setModel] = useState(bot.model ?? "")
  const [access, setAccess] = useState<string>(
    bot.provider !== "codex" && bot.access === "full" && bot.approvals === "on-request" ? "full-approved" : bot.access,
  )
  const initialAccess = useRef(access)
  const [effort, setEffort] = useState<Bot["reasoningEffort"]>(bot.reasoningEffort)
  const [projectId, setProjectId] = useState(bot.projectId ?? "")
  const [addingProject, setAddingProject] = useState(false)
  const [folders, setFolders] = useState(bot.folders ?? [])
  const [anyFolderAccess, setAnyFolderAccess] = useState(bot.anyFolderAccess ?? false)
  const [profile, setProfile] = useState({
    providerProfile: bot.providerProfile ?? null,
    claudeAiConnectors: bot.claudeAiConnectors ?? false,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const immediateAction = async (task: () => Promise<void>): Promise<void> => {
    if (updating || saving) return
    setUpdating(true)
    setSaveError(null)
    try {
      await task()
    } catch (error) {
      setSaveError(userFacingError(error))
    } finally {
      setUpdating(false)
    }
  }
  const permissionsRef = useRef<HTMLSelectElement>(null)
  const [grantsRevision, setGrantsRevision] = useState(0)
  const [section, setSection] = useState<string>(
    initialSection ?? (focusMcp ? "tools" : permissionsOnly ? "access" : "model"),
  )
  const [advanced, setAdvanced] = useState(Boolean(initialSection || focusMcp || permissionsOnly || focusSetting))
  useSettingFocus(focusSetting)
  useEffect(() => {
    if (!permissionsOnly) return
    permissionsRef.current?.closest("label")?.scrollIntoView?.({ block: "start" })
    permissionsRef.current?.focus({ preventScroll: true })
  }, [permissionsOnly])
  const save = async (): Promise<void> => {
    if (saving || updating) return
    if (
      machine.machine === "vm" &&
      (!Number.isInteger(machine.machineIdleMinutes) ||
        machine.machineIdleMinutes < 1 ||
        machine.machineIdleMinutes > 1440)
    ) {
      setSection("computer")
      setAdvanced(true)
      setSaveError(t("Escolha de 1 a 1.440 minutos sem atividade."))
      return
    }
    if (!name.trim()) {
      setAdvanced(false)
      setSaveError(t("Dê um nome ao bot."))
      return
    }
    const validName = normalizeBotName(name)
    if (!validName) {
      setAdvanced(false)
      setSaveError(t("Use de 1 a 80 caracteres, sem quebras de linha ou caracteres de controle."))
      return
    }
    if (settings && (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384)) {
      setAdvanced(true)
      setSection("computer")
      setSaveError(t("Escolha de 512 a 16.384 MiB por computador do bot."))
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      if (settings && vmMemory !== (settings.botVmMemoryMb ?? 1536))
        await actions.updateSettings({ botVmMemoryMb: vmMemory })
      await actions.updateBot(bot.id, {
        name: validName,
        ...avatar,
        ...machineChanges,
        browser,
        roleLine: roleLine.trim() || null,
        title: title.trim() || null,
        instructions,
        provider,
        model: model || null,
        access: access === "full-approved" ? "full" : (access as Bot["access"]),
        approvals:
          provider === bot.provider && access === initialAccess.current
            ? bot.approvals
            : access === "full" || (provider === "codex" && access === "full-approved")
              ? "never"
              : "on-request",
        reasoningEffort: effort,
        projectId: projectId || null,
        folders,
        anyFolderAccess,
        ...(machine.machine === "local" && provider !== "opencode"
          ? {
              providerProfile: profile.providerProfile,
              claudeAiConnectors: provider === "claude" && profile.claudeAiConnectors,
            }
          : { providerProfile: null, claudeAiConnectors: false }),
      })
      onClose()
    } catch (error) {
      setSaveError(userFacingError(error))
    } finally {
      setSaving(false)
    }
  }
  const botRoutines = routines.filter((routine) => routine.botId === bot.id)
  const sections = BOT_SETTINGS_SECTIONS
  const botPane = (id: BotSettingsSectionId) => {
    const entry = BOT_SETTINGS_SECTIONS.find((candidate) => candidate.id === id)
    return { active: section, id, title: entry?.label ?? id, description: entry?.description ?? "" }
  }
  const draftAccess = {
    access: access === "full-approved" ? ("full" as const) : (access as Bot["access"]),
    approvals:
      provider === bot.provider && access === initialAccess.current
        ? bot.approvals
        : access === "full" || (provider === "codex" && access === "full-approved")
          ? ("never" as const)
          : ("on-request" as const),
  }
  const [secretNotice, setSecretNotice] = useState("")
  return (
    <Modal
      onClose={onClose}
      title={permissionsOnly ? t("Permissões do bot") : t("Bot settings", { name: bot.name })}
      eyebrow={t("configuração do bot")}
      className="settings-modal"
    >
      <div className="bot-settings-overview" hidden={advanced}>
        <SettingsGroup>
          <SettingsRow title={t("Name")} description={t("Como você chama este bot.")} htmlFor="settings-name">
            <input
              id="settings-name"
              data-initial-focus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            title={t("O que ele faz")}
            description={t("Um resumo do trabalho do bot na equipe.")}
            htmlFor="settings-role"
          >
            <input id="settings-role" value={roleLine} onChange={(event) => setRoleLine(event.target.value)} />
          </SettingsRow>
        </SettingsGroup>
        <div className="settings-avatar-field">
          <AvatarPicker
            label={t("Mascote")}
            name={name}
            bot={{ ...bot, ...avatar }}
            onChange={(choice) => setAvatar((current) => ({ ...current, ...choice }))}
          />
        </div>
        <BotAccessSummary
          host={host}
          {...draftAccess}
          machine={machine.machine}
          folders={folders}
          anyFolderAccess={anyFolderAccess}
        />
      </div>
      {machine.machine !== "cloud" && (
        <ApiModelPicker
          api={api}
          id="settings-api-model"
          value={provider === "opencode" && model.startsWith("touri-api-") ? model : ""}
          disabled={saving || updating}
          onChange={(value) => {
            setModel(value)
            setEffort(null)
            if (value) setProvider("opencode")
          }}
        />
      )}
      <div className="settings-advanced-bar">
        <span id="settings-advanced-context" className="settings-advanced-context">
          {t("Ajustes deste bot")}
        </span>
        <button
          type="button"
          className="button button-quiet"
          aria-labelledby="settings-advanced-label settings-advanced-context"
          aria-expanded={advanced}
          aria-controls="bot-advanced-settings"
          onClick={() => setAdvanced((current) => !current)}
        >
          <span id="settings-advanced-label">{t("Avançado")}</span>
          <span aria-hidden="true">{advanced ? "−" : "+"}</span>
        </button>
      </div>
      {/* Unmounted while collapsed: WebKit drops every later sibling from the macOS accessibility tree when a display:none subtree holds a <select>. */}
      {advanced && (
        <div id="bot-advanced-settings" className="settings-advanced-content">
          <SettingsLayout
            sections={sections}
            active={section}
            onChange={(next) => (next === "routines" && onOpenRoutines ? onOpenRoutines() : setSection(next))}
            label={t("Seções das configurações do bot")}
          >
            <SettingsPane {...botPane("model")}>
              <SettingsGroup title={t("Provedor e modelo")}>
                <SettingsRow
                  title={t("Provider")}
                  description={t("O programa que executa as tarefas deste bot.")}
                  htmlFor="settings-provider"
                >
                  <select
                    id="settings-provider"
                    value={provider}
                    onChange={(event) => {
                      if (api)
                        void api
                          .request("POST /bots/:id/provider-login/flow", { provider, action: "cancel" }, { id: bot.id })
                          .catch(() => {})
                      setProvider(event.target.value as Bot["provider"])
                      setModel("")
                      setEffort(null)
                      setMachine((current) => ({ ...current, vmProviderLogin: false }))
                    }}
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude Code</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                </SettingsRow>
                <SettingsRow
                  title={t("Model")}
                  description={t("Deixe em branco para usar o padrão do provedor.")}
                  htmlFor="settings-model"
                >
                  <div className="settings-model-control">
                    <ProviderModelField
                      id="settings-model"
                      api={api}
                      botId={bot.id}
                      provider={provider}
                      value={model}
                      onChange={setModel}
                    />
                  </div>
                </SettingsRow>
                <SettingsRow
                  title={t("Reasoning")}
                  description={t("A profundidade de raciocínio nas próximas tarefas.")}
                  htmlFor="settings-effort"
                >
                  <select
                    id="settings-effort"
                    value={effort ?? ""}
                    onChange={(event) => setEffort((event.target.value || null) as Bot["reasoningEffort"])}
                  >
                    <option value="">{t("Padrão do provedor")}</option>
                    <option value="low">{t("Low")}</option>
                    <option value="medium">{t("Medium")}</option>
                    <option value="high">{t("High")}</option>
                    <option value="xhigh">{t("Extra high")}</option>
                  </select>
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title={t("Instruções")}>
                <section>
                  <SettingsRow
                    title={t("Título (opcional)")}
                    description={t("Uma identificação curta para este bot.")}
                    htmlFor="settings-title"
                  >
                    <input id="settings-title" value={title} onChange={(event) => setTitle(event.target.value)} />
                  </SettingsRow>

                  <label htmlFor="soul">{t("Bot instructions")}</label>
                  <textarea
                    id="soul"
                    className="soul-editor"
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    aria-describedby="soul-help"
                  />
                  <small id="soul-help" className="field-help">
                    {t("Detailed guidance for the bot. Saved as SOUL.md in the bot’s folder.")}{" "}
                    {t("Takes effect from the next message.")}
                  </small>
                  {instructions.includes("coordinate_bots") && (
                    <p className="warning-callout">
                      {t(
                        "Estas instruções mencionam uma ferramenta de coordenação indisponível. Envie a tarefa a cada bot ou conecte uma ferramenta própria.",
                      )}
                    </p>
                  )}
                </section>
              </SettingsGroup>
              <SettingsGroup title={t("Excluir bot")}>
                <p>{t("Remove este bot, suas conversas, rotinas e seu computador.")}</p>
                <button
                  type="button"
                  className="tool-action tool-action-deny"
                  disabled={saving || updating}
                  onClick={() => setDeleting(true)}
                >
                  {t("Excluir bot")}
                </button>
                {deleting && (
                  <DeleteBotDialog
                    bot={bot}
                    onDelete={async (...args) => {
                      await actions.deleteBot(...args)
                      onClose()
                    }}
                    onClose={() => setDeleting(false)}
                  />
                )}
              </SettingsGroup>
            </SettingsPane>
            <SettingsPane {...botPane("computer")}>
              <SettingsGroup>
                <MachineFields
                  activeTurns={activeTurns}
                  values={machine}
                  provider={provider}
                  {...(capability ? { capability } : {})}
                  {...(machineState ? { state: machineState } : {})}
                  onChange={(patch) => {
                    setMachine((current) => ({ ...current, ...patch }))
                    if (patch.machine)
                      setBrowser((current) =>
                        patch.machine === "vm"
                          ? "machine"
                          : current === "machine" || patch.machine === "cloud"
                            ? "touri"
                            : current,
                      )
                  }}
                  technicalDetailsOpen={Boolean(
                    saveError && settings && (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384),
                  )}
                  technicalDetails={
                    settings && (
                      <SettingsRow
                        title={SETTINGS.vmMemory.label}
                        description={t(
                          "Este limite vale para todos os computadores isolados; é aplicado ao criar ou atualizar cada um.",
                        )}
                        htmlFor="bot-vm-memory"
                      >
                        <input
                          id="bot-vm-memory"
                          type="number"
                          min={512}
                          max={16384}
                          value={vmMemory}
                          onChange={(event) => setVmMemory(Number(event.target.value))}
                        />
                      </SettingsRow>
                    )
                  }
                  {...(bot.machine === "vm"
                    ? {
                        onAction: (reset: boolean, stopTurns?: boolean) =>
                          actions.machineAction(
                            bot.id,
                            reset,
                            reset && (projectId || null) !== bot.projectId ? projectId || null : undefined,
                            stopTurns,
                          ),
                      }
                    : {})}
                />

                {api && bot.machine === "vm" && (
                  <Suspense fallback={<BotSettingsLoading />}>
                    <BotNetworkSettings api={api} botId={bot.id} />
                  </Suspense>
                )}
              </SettingsGroup>
              {((hostComputerSupported && !serverMode) || machine.machine === "vm") && (
                <SettingsGroup title={t("Controle do computador")}>
                  <label className="toggle-row" htmlFor="settings-computer-use" data-setting-id="computerUse">
                    <span>
                      <strong>{t("Computer use")}</strong>
                      <small>
                        {machine.machine === "vm" && !machine.hostComputerUse
                          ? t("Controls only Xvfb in the VM; cannot access the host screen.")
                          : t("Off by default; each turn still needs a time-boxed grant.")}
                      </small>
                    </span>
                    <SettingsSwitch
                      id="settings-computer-use"
                      checked={bot.computerUse}
                      disabled={updating || saving}
                      onChange={(event) => {
                        const computerUse = event.target.checked
                        void immediateAction(() => actions.updateBot(bot.id, { computerUse }))
                      }}
                    />
                  </label>
                </SettingsGroup>
              )}
              <SettingsGroup>
                <label className="toggle-row" htmlFor="settings-browser" data-setting-id="browserEnabled">
                  <span>
                    <strong>{t("Browser enabled")}</strong>
                    <small>{t("Allow this teammate to use its own browser tabs.")}</small>
                  </span>
                  <SettingsSwitch
                    id="settings-browser"
                    checked={bot.browserEnabled}
                    disabled={updating || saving}
                    onChange={(event) => {
                      const browserEnabled = event.target.checked
                      void immediateAction(() => actions.updateBot(bot.id, { browserEnabled }))
                    }}
                  />
                </label>
                <BotBrowserPicker
                  value={browser}
                  machine={machine.machine}
                  disabled={saving || updating}
                  onChange={setBrowser}
                />
              </SettingsGroup>
            </SettingsPane>
            <SettingsPane {...botPane("project")}>
              <SettingsGroup title={t("Projeto")}>
                <div className="settings-fields">
                  <label>
                    {t("Projeto")}
                    <select
                      value={projectId}
                      disabled={activeTurns || saving || updating || machine.machine === "cloud"}
                      onChange={(event) =>
                        event.target.value === "__add_project__"
                          ? setAddingProject(true)
                          : setProjectId(event.target.value)
                      }
                    >
                      <option value="">{t("Nenhum projeto (começa na pasta do bot)")}</option>
                      {projects
                        .filter((project) => !project.archivedAt)
                        .map((project) => (
                          <option value={project.id} key={project.id}>
                            {project.name}
                          </option>
                        ))}
                      <option value="__add_project__" disabled={!api || !invokeCommand}>
                        {t("Adicionar projeto…")}
                      </option>
                    </select>
                  </label>
                  {addingProject && api && invokeCommand && (
                    <ProjectModal
                      project={null}
                      selectedBotId={bot.id}
                      linkBotId={bot.id}
                      bots={bots ?? [bot]}
                      api={api}
                      invokeCommand={invokeCommand}
                      actions={actions}
                      onLinked={(project, folder) => {
                        setProjectId(project.id)
                        if (folder)
                          setFolders(
                            (current) => projectFolderPatch(current, folder, machine.machine).folders ?? current,
                          )
                      }}
                      onClose={() => setAddingProject(false)}
                      onOpenPreview={() => setAddingProject(false)}
                      onNotice={() => {}}
                    />
                  )}
                </div>
              </SettingsGroup>
              <SettingsGroup>
                <SettingsRow
                  title={t("Pasta de trabalho")}
                  description={t("A pasta usada para começar as tarefas deste bot.")}
                >
                  <code>
                    {bot.cwd || projects.find((candidate) => candidate.id === projectId)?.path || bot.homeDir}
                  </code>
                </SettingsRow>
              </SettingsGroup>
            </SettingsPane>
            <SettingsPane {...botPane("access")}>
              <SettingsGroup title={t("Nível de acesso")}>
                <div className="settings-fields">
                  <label>
                    {t("Access")}
                    <select
                      ref={permissionsRef}
                      value={provider === "codex" && access === "full-approved" ? "full" : access}
                      onChange={(event) => setAccess(event.target.value as Bot["access"])}
                    >
                      <option value="read-only">{accessLabel({ access: "read-only", approvals: "on-request" })}</option>
                      <option value="workspace-write">
                        {accessLabel({
                          access: "workspace-write",
                          approvals:
                            provider === bot.provider && initialAccess.current === "workspace-write"
                              ? bot.approvals
                              : "on-request",
                        })}
                      </option>
                      <option value="full">{accessLabel({ access: "full", approvals: "never" })}</option>
                      {provider !== "codex" && (
                        <option value="full-approved">
                          {accessLabel({ access: "full", approvals: "on-request" })}
                        </option>
                      )}
                    </select>
                  </label>
                  <BotAccessSummary
                    host={host}
                    {...draftAccess}
                    machine={machine.machine}
                    folders={folders}
                    anyFolderAccess={anyFolderAccess}
                  />
                  {(access === "full" || access === "full-approved") && (
                    <div className="warning-callout">
                      {fullAccessDescription({ ...draftAccess, machine: machine.machine })}
                    </div>
                  )}
                </div>
              </SettingsGroup>
              {api && !model.startsWith("touri-api-") && machine.machine !== "cloud" && (
                <ProviderLogin
                  key={provider}
                  api={api}
                  botId={bot.id}
                  provider={provider}
                  onConfigured={() => setMachine((current) => ({ ...current, vmProviderLogin: true }))}
                />
              )}
              {api && machine.machine === "local" && (
                <ProviderProfileFields
                  api={api}
                  provider={provider}
                  values={profile}
                  onChange={(patch) => setProfile((current) => ({ ...current, ...patch }))}
                />
              )}
              {machine.machine !== "cloud" && (
                <BotFolderSettings
                  api={api}
                  onUpload={onAttachFile}
                  readOnly={access === "read-only"}
                  fullAccess={draftAccess.access === "full"}
                  folders={folders}
                  anyFolderAccess={anyFolderAccess}
                  machine={machine.machine}
                  disabled={saving || updating}
                  invokeCommand={invokeCommand}
                  onFolders={setFolders}
                  onAnyFolderAccess={setAnyFolderAccess}
                />
              )}
              {api && (
                <SecretsPanel
                  project={projects.find((candidate) => candidate.id === projectId) ?? null}
                  api={api}
                  invokeSecret={async (account, value) =>
                    invokeCommand ? (await invokeCommand("secret_save", { account, value })) !== null : false
                  }
                  onNotice={setSecretNotice}
                />
              )}
              {secretNotice && <p role="status">{secretNotice}</p>}
            </SettingsPane>
            <SettingsPane {...botPane("permissions")}>
              {api && (
                <Suspense fallback={<BotSettingsLoading />}>
                  <BotStandingGrants key={grantsRevision} api={api} botId={bot.id} />
                </Suspense>
              )}
              <p className="field-help">
                {bot.machine === "vm"
                  ? t("Assumir controle não autoriza ações automáticas do bot. Revise essas ações no chat.")
                  : t("O controle do computador precisa de uma permissão por tempo limitado em cada conversa.")}
              </p>
              {api &&
                (!serverMode || bot.machine === "vm") &&
                bot.computerUse &&
                bot.mainThreadId &&
                "__TAURI_INTERNALS__" in window && (
                  <>
                    <p>{t("Esta permissão vale para a conversa principal deste bot.")}</p>
                    <ComputerGrantCard api={api} botId={bot.id} threadId={bot.mainThreadId} botName={bot.name} />
                  </>
                )}
            </SettingsPane>
            <SettingsPane {...botPane("tools")}>
              {api && (
                <Suspense fallback={<BotSettingsLoading />}>
                  <BotMcpSettings
                    api={api}
                    botId={bot.id}
                    botName={bot.name}
                    onContinue={onClose}
                    onAttach={onAttachFile}
                    onFolder={() => setSection("access")}
                    machine={bot.machine}
                    invokeCommand={invokeCommand}
                    onPermissionsChange={() => setGrantsRevision((revision) => revision + 1)}
                    focusOnOpen={focusMcp}
                    {...(onOpenIntegrations ? { onOpenIntegrations } : {})}
                  />
                </Suspense>
              )}
            </SettingsPane>
            <SettingsPane {...botPane("routines")}>
              {onOpenRoutines && (
                <button type="button" className="text-button" onClick={onOpenRoutines}>
                  {t("Manage routines")}
                </button>
              )}
              <SettingsGroup title={`${botRoutines.length} ${plural(botRoutines.length, "rotina", "rotinas")}`}>
                <section>
                  {botRoutines.map((routine) => (
                    <div className="routine-row" key={routine.id}>
                      <span>
                        <strong>{routine.name}</strong>
                        <RoutineSchedule routine={routine} />
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={updating || saving}
                        onClick={() => void immediateAction(() => actions.runRoutine(routine.id))}
                      >
                        {t("Run now")}
                      </button>
                      <SettingsSwitch
                        checked={routine.enabled}
                        disabled={updating || saving}
                        onChange={() => void immediateAction(() => actions.toggleRoutine(routine))}
                        aria-label={t("Enable routine", { name: routine.name })}
                      />
                      <button
                        type="button"
                        className="routine-delete-button"
                        disabled={updating || saving}
                        aria-label={t("Excluir rotina {name}", { name: routine.name })}
                        onClick={(event) => {
                          routinesFocusRef.current = event.currentTarget.closest('[role="tabpanel"]')
                          setDeletingRoutine(routine)
                        }}
                      >
                        {t("Excluir rotina")}
                      </button>
                    </div>
                  ))}
                  {botRoutines.length === 0 && (
                    <p className="muted-copy">
                      {t("No routines. Agents can propose disabled routines for you to review.")}
                    </p>
                  )}
                </section>
              </SettingsGroup>
            </SettingsPane>
          </SettingsLayout>
        </div>
      )}
      {deletingRoutine && (
        <DeleteRoutineDialog
          routine={deletingRoutine}
          onDelete={actions.deleteRoutine}
          onClose={() => setDeletingRoutine(null)}
          onDeleted={() => routinesFocusRef.current?.focus()}
        />
      )}
      {saveError && (
        <p className="settings-save-error warning-callout" role="alert">
          {saveError}
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: WebKit drops flex fieldset children from the macOS accessibility tree. */}
      <div className="modal-actions" role="group" aria-label={t("Ações das configurações do bot")}>
        <button type="button" className="button button-quiet" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button type="button" className="button button-brand" onClick={() => void save()} disabled={saving || updating}>
          {saving ? t("Saving…") : t("Save settings")}
        </button>
      </div>
    </Modal>
  )
}

type ProjectModalProps = {
  linkBotId?: string | null
  onLinked?: (project: Project, folder?: BotFolder) => void

  project: Project | null
  selectedBotId: string | null
  bots: Array<Bot>
  api: UiApi
  invokeCommand: TauriInvoke
  actions: WorkspaceActions
  onClose: () => void
  onOpenPreview: () => void
  onNotice: (message: string) => void
}

type ProcessEntry = { spec: ProcessSpec; run: import("@touri/contracts").ProcessRunState | null }

// Leave '..' to the sidecar: resolving it here could misidentify paths through symlinks.
const folderKey = (value: string): string =>
  `/${value
    .trim()
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== ".")
    .join("/")}`

export const ProjectModal = ({
  linkBotId,
  onLinked,
  project,
  selectedBotId,
  bots,
  api,
  invokeCommand,
  actions,
  onClose,
  onOpenPreview,
  onNotice,
}: ProjectModalProps) => {
  const selectedBot = bots.find((bot) => bot.id === selectedBotId)
  const vmBotId = selectedBot?.machine === "vm" ? selectedBot.id : null
  const [pickingFolder, setPickingFolder] = useState(false)
  const [projectFolder, setProjectFolder] = useState<BotFolder | null>(null)
  const [source, setSource] = useState<"folder" | "clone">("folder")
  const [path, setPath] = useState(project?.path ?? "")
  const [gitUrl, setGitUrl] = useState("")
  const [parentDir, setParentDir] = useState("")
  const [name, setName] = useState(project?.name ?? "")
  const [connectedProject, setConnectedProject] = useState<Project | null>(project)
  const [selectedBotIds, setSelectedBotIds] = useState<Array<string>>(
    project
      ? bots.filter((bot) => bot.projectId === project.id).map((bot) => bot.id)
      : selectedBotId
        ? [selectedBotId]
        : [],
  )
  const [processes, setProcesses] = useState<Array<ProcessEntry>>([])
  const [secrets, setSecrets] = useState<Array<SecretMeta>>([])
  const [step, setStep] = useState<"project" | "process">(project ? "process" : "project")
  const [processFormOpen, setProcessFormOpen] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [knownProjects, setKnownProjects] = useState<Project[]>([])
  const [returnedExisting, setReturnedExisting] = useState<Project | null>(null)
  const existingProject =
    !connectedProject && source === "folder" && path.trim().startsWith("/")
      ? (returnedExisting ?? knownProjects.find((item) => folderKey(item.path) === folderKey(path)))
      : null
  const projectErrorRef = useRef<HTMLParagraphElement>(null)
  const existingProjectRef = useRef<HTMLDivElement>(null)
  const [projectGit, setProjectGit] = useState<ApiRoutes["GET /projects/:id/git"]["res"] | null>(null)
  const [savingProcess, setSavingProcess] = useState(false)
  const [processName, setProcessName] = useState("web")
  const [command, setCommand] = useState("pnpm dev")
  const [cwd, setCwd] = useState(".")
  const [autoDetect, setAutoDetect] = useState(true)
  const [previewPort, setPreviewPort] = useState("")
  const [envRows, setEnvRows] = useState<Array<{ id: string; key: string; secret: string }>>([])
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null)
  const [logs, setLogs] = useState<Record<string, Array<string>>>({})

  useEffect(() => {
    if (projectError) projectErrorRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [projectError])

  useEffect(() => {
    if (returnedExisting) existingProjectRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [returnedExisting])

  useEffect(() => {
    let active = true
    void api
      .request("GET /projects", {})
      .then((result) => {
        if (active) setKnownProjects(result.projects)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [api])

  const changeSource = (change: () => void, resetFolder = true) => {
    change()
    setConnectedProject(null)
    setProjectGit(null)
    setProjectError(null)
    setReturnedExisting(null)
    if (resetFolder) setProjectFolder(null)
  }

  const chooseFolder = async (): Promise<void> => setPickingFolder(true)

  const refreshProjectDetails = useCallback(
    async (nextProject: Project): Promise<void> => {
      try {
        const [processResponse, secretResponse, gitResponse] = await Promise.all([
          api.request("GET /projects/:id/processes", vmBotId ? { vmBotId } : {}, { id: nextProject.id }),
          api.request("GET /projects/:id/secrets", {}, { id: nextProject.id }),
          api.request("GET /projects/:id/git", {}, { id: nextProject.id }),
        ])
        setProcesses(processResponse.processes)
        setSecrets(secretResponse.secrets)
        setProjectGit(gitResponse)
      } catch {
        setProjectError(
          "O projeto foi conectado, mas os detalhes não estão disponíveis. Confira a conexão com o touri e reabra este diálogo.",
        )
      }
    },
    [api, vmBotId],
  )

  useEffect(() => {
    if (!connectedProject) return
    void refreshProjectDetails(connectedProject)
  }, [connectedProject, refreshProjectDetails])

  useEffect(() => {
    if (!connectedProject) return
    return api.subscribe((envelope) => {
      const event = envelope.event
      if (
        event.type === "preview.available" &&
        event.preview.projectId === connectedProject.id &&
        (event.preview.vmBotId ?? null) === vmBotId
      )
        onOpenPreview()
      if (
        event.type === "process.updated" &&
        event.spec.projectId === connectedProject.id &&
        (event.spec.vmBotId ?? null) === vmBotId
      )
        setProcesses((current) => {
          const next = { spec: event.spec, run: event.run }
          return [...current.filter((entry) => entry.spec.id !== event.spec.id), next]
        })
      if (event.type === "process.log")
        setLogs((current) => ({ ...current, [event.processId]: [...(current[event.processId] ?? []), ...event.lines] }))
    })
  }, [api, connectedProject, onOpenPreview, vmBotId])

  const connect = async (useExisting?: Project, discovered?: DiscoveredProject): Promise<void> => {
    if (savingProject) return
    const requestedPath = discovered?.path ?? path.trim()
    const requestedName = discovered?.name ?? name.trim()
    if (!useExisting && !discovered && source === "folder" && !requestedPath) return
    if (!useExisting && !discovered && source === "clone" && (!gitUrl.trim() || !parentDir.trim())) return
    setSavingProject(true)
    setProjectError(null)
    try {
      if (!discovered && source === "folder" && !connectedProject && !useExisting) {
        const result = await api.request("GET /projects", {})
        setKnownProjects(result.projects)
        const existing = result.projects.find((item) => folderKey(item.path) === folderKey(path))
        if (existing) {
          setReturnedExisting(existing)
          return
        }
      }
      const input: ApiRoutes["POST /projects"]["req"] =
        discovered || source === "folder"
          ? { path: requestedPath, ...(requestedName ? { name: requestedName } : {}) }
          : {
              gitUrl: gitUrl.trim(),
              parentDir: parentDir.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
            }
      const nextProject = discovered
        ? await actions.createProject(input)
        : (connectedProject ?? useExisting ?? (await actions.createProject(input)))
      // The sidecar canonicalizes paths (including symlinks) and may return an existing project.
      // Keep the form and requested name until the user explicitly accepts that project.
      if (
        !discovered &&
        !connectedProject &&
        !useExisting &&
        source === "folder" &&
        name.trim() &&
        nextProject.name !== name.trim()
      ) {
        setReturnedExisting(nextProject)
        return
      }
      setConnectedProject(nextProject)
      const grant = !discovered && projectFolder ? { ...projectFolder, path: nextProject.path } : undefined
      setProjectFolder(grant ?? null)
      const folderPatch = (botId: string) => {
        const bot = bots.find((bot) => bot.id === botId)
        return grant && bot ? projectFolderPatch(bot.folders ?? [], grant, bot.machine) : {}
      }
      if (linkBotId) {
        await actions.updateBot(linkBotId, { projectId: nextProject.id, ...folderPatch(linkBotId) })
        onLinked?.(nextProject, grant)
      }
      await Promise.all(
        selectedBotIds
          .filter((botId) => botId !== linkBotId)
          .map((botId) => actions.updateBot(botId, { projectId: nextProject.id, ...folderPatch(botId) })),
      )
      if (!linkBotId) onLinked?.(nextProject, grant)
      setStep("process")
      setProcessFormOpen(true)
      onNotice("Projeto conectado. Escolha os bots e adicione um processo supervisionado.")
    } catch (error) {
      setProjectError(
        `Não foi possível conectar o projeto. ${error instanceof Error && error.message.trim() ? error.message : "Confira a pasta e o acesso ao Git; depois tente novamente."}`,
      )
    } finally {
      setSavingProject(false)
    }
  }

  const saveAssignments = async (): Promise<void> => {
    if (!connectedProject) return
    setProjectError(null)
    try {
      const current = bots.filter((bot) => bot.projectId === connectedProject.id)
      const affected = [...bots.filter((bot) => selectedBotIds.includes(bot.id)), ...current]
      await Promise.all(
        [...new Map(affected.map((bot) => [bot.id, bot])).values()].map((bot) =>
          actions.updateBot(bot.id, {
            projectId: selectedBotIds.includes(bot.id) ? connectedProject.id : null,
            ...(selectedBotIds.includes(bot.id) && projectFolder
              ? projectFolderPatch(bot.folders ?? [], { ...projectFolder, path: connectedProject.path }, bot.machine)
              : {}),
          }),
        ),
      )
      onNotice("Atribuição de projeto atualizada.")
    } catch (error) {
      setProjectError(`Não foi possível atribuir todos os bots. ${userFacingError(error)}`)
    }
  }

  const env = envRows.reduce<Record<string, EnvValue>>((result, row) => {
    if (row.key.trim() && row.secret) result[row.key.trim().toUpperCase()] = { secret: row.secret }
    return result
  }, {})

  const addProcess = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!connectedProject || !processName.trim() || !command.trim()) return
    setSavingProcess(true)
    try {
      const port = Number(previewPort)
      await actions.createProcess(connectedProject.id, processName.trim(), {
        command: command.trim(),
        cwd: cwd.trim() || ".",
        env,
        autostart: false,
        restart: "on-failure",
        dependsOn: [],
        ready: autoDetect ? null : Number.isInteger(port) && port > 0 ? { port } : null,
        previewPort: autoDetect || !Number.isInteger(port) || port <= 0 ? null : port,
        createdBy: "user",
      })
      await refreshProjectDetails(connectedProject)
      setProcessFormOpen(false)
      setProcessName("")
      setCommand("")
      onNotice("Processo adicionado. Inicie-o para detectar uma porta HTTP.")
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Não foi possível adicionar o processo.")
    } finally {
      setSavingProcess(false)
    }
  }

  const processAction = async (action: "start" | "stop" | "restart", processId: string): Promise<void> => {
    try {
      if (action === "start") await actions.startProcess(processId)
      if (action === "stop") await actions.stopProcess(processId)
      if (action === "restart") await actions.restartProcess(processId)
      if (connectedProject) await refreshProjectDetails(connectedProject)
      const previewResponse = await api.request(
        "GET /previews",
        connectedProject ? { projectId: connectedProject.id } : {},
      )
      if (previewResponse.previews.some((preview) => (preview.vmBotId ?? null) === vmBotId)) onOpenPreview()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Não foi possível controlar o processo.")
    }
  }

  const loadProcessLogs = async (processId: string): Promise<void> => {
    setExpandedLogs(processId)
    try {
      const response = await api.request("GET /processes/:id/logs", { tail: 200 }, { id: processId })
      setLogs((current) => ({ ...current, [processId]: response.lines }))
    } catch {
      setLogs((current) => ({ ...current, [processId]: [t("Logs indisponíveis para este processo.")] }))
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={t("Conectar projeto")}
      eyebrow={`projeto / ${step === "project" ? "fonte" : "processos"}`}
    >
      {projectError && (
        <p role="alert" ref={projectErrorRef}>
          {projectError}
        </p>
      )}
      {step === "project" ? (
        <div className="project-wizard-content">
          <div className="project-source-tabs" role="tablist" aria-label={t("Origem do projeto")}>
            <button
              type="button"
              className={source === "folder" ? "active" : ""}
              onClick={() => changeSource(() => setSource("folder"))}
              disabled={savingProject}
            >
              {t("Pasta local")}
            </button>
            <button
              type="button"
              className={source === "clone" ? "active" : ""}
              onClick={() => changeSource(() => setSource("clone"))}
              disabled={savingProject}
            >
              {t("Git clone")}
            </button>
          </div>
          {source === "folder" ? (
            <>
              <DiscoveredProjects
                api={api}
                disabled={savingProject}
                onSelect={(repository) => connect(undefined, repository)}
                onChooseFolder={chooseFolder}
              />
              <label htmlFor="project-path">{t("Pasta do projeto")}</label>
              <div className="input-with-button">
                <input
                  id="project-path"
                  disabled={savingProject}
                  value={path}
                  onChange={(event) => changeSource(() => setPath(event.target.value))}
                  placeholder={t("Caminho absoluto da pasta")}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => void chooseFolder()}
                  disabled={savingProject}
                  aria-label={t("Escolher pasta")}
                >
                  ⌁
                </button>
              </div>
              <small className="field-help">{t("Escolha uma pasta navegando pelas pastas deste computador.")}</small>
            </>
          ) : (
            <>
              <label htmlFor="project-git-url">{t("URL do repositório")}</label>
              <input
                id="project-git-url"
                disabled={savingProject}
                value={gitUrl}
                onChange={(event) => changeSource(() => setGitUrl(event.target.value))}
                placeholder="git@github.com:org/repo.git"
              />
              <label htmlFor="project-parent-dir">{t("Pasta para clonar")}</label>
              <input
                id="project-parent-dir"
                disabled={savingProject}
                value={parentDir}
                onChange={(event) => changeSource(() => setParentDir(event.target.value))}
              />
            </>
          )}
          <label htmlFor="project-name">{t("Nome do projeto")}</label>
          <input
            id="project-name"
            disabled={savingProject}
            value={name}
            onChange={(event) => changeSource(() => setName(event.target.value), false)}
            placeholder={t("Meu projeto")}
          />
          {existingProject && (
            <div ref={existingProjectRef} className="settings-inline-note" role="status">
              <p>Esta pasta já está conectada como {existingProject.name}</p>
              <p>
                Cada pasta pode ter apenas um projeto. Para conectar
                {name.trim() ? ` “${name.trim()}”` : " com outro nome"}, escolha outra pasta. Seu nome digitado será
                mantido.
              </p>
            </div>
          )}
          <fieldset className="bot-assignment-fieldset">
            <legend>{t("Bots que podem usar este projeto")}</legend>
            {bots.map((bot) => (
              <label className="toggle-row" key={bot.id}>
                <span>
                  <strong>{bot.name}</strong>
                  <small>{bot.provider}</small>
                </span>
                <input
                  type="checkbox"
                  disabled={savingProject || bot.id === linkBotId}
                  checked={selectedBotIds.includes(bot.id) || bot.id === linkBotId}
                  onChange={(event) =>
                    setSelectedBotIds((current) =>
                      event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id),
                    )
                  }
                />
              </label>
            ))}
          </fieldset>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>
              {t("Cancelar")}
            </button>
            <button
              type="button"
              className="button button-brand"
              onClick={() => void connect(existingProject ?? undefined)}
              disabled={savingProject || (source === "folder" ? !path.trim() : !gitUrl.trim() || !parentDir.trim())}
            >
              {savingProject
                ? t("Conectando…")
                : existingProject
                  ? `Usar ${existingProject.name}`
                  : t("Conectar projeto")}
            </button>
          </div>
        </div>
      ) : connectedProject ? (
        <div className="project-process-content">
          <div className="project-connected-summary">
            <div>
              <strong>{connectedProject.name}</strong>
              <small>{connectedProject.path}</small>
              <small>Origem: {projectGit?.remote ?? connectedProject.gitRemote ?? connectedProject.path}</small>
              <small>
                Commit: {projectGit ? (projectGit.commit ?? "Pasta sem commit Git") : "Verificando commit Git…"}
              </small>
            </div>
            <button type="button" className="text-button" onClick={() => void saveAssignments()}>
              {t("Salvar bots")}
            </button>
          </div>
          <fieldset className="bot-assignment-fieldset">
            <legend>{t("Bots atribuídos")}</legend>
            {bots.map((bot) => (
              <label className="toggle-row" key={bot.id}>
                <span>
                  <strong>{bot.name}</strong>
                  <small>{bot.projectId === connectedProject.id ? t("atribuído") : t("não atribuído")}</small>
                </span>
                <input
                  type="checkbox"
                  disabled={bot.id === linkBotId}
                  checked={selectedBotIds.includes(bot.id) || bot.id === linkBotId}
                  onChange={(event) =>
                    setSelectedBotIds((current) =>
                      event.target.checked ? [...current, bot.id] : current.filter((id) => id !== bot.id),
                    )
                  }
                />
              </label>
            ))}
          </fieldset>
          <SecretsPanel
            project={connectedProject}
            api={api}
            invokeSecret={async (account, value) => (await invokeCommand("secret_save", { account, value })) !== null}
            onNotice={onNotice}
            onSaved={() => void refreshProjectDetails(connectedProject)}
          />
          <div className="process-definition-heading">
            <div>
              <p className="eyebrow">{t("supervisor")}</p>
              <h3>{t("Processos")}</h3>
            </div>
            <button
              type="button"
              className="button button-dark"
              onClick={() => setProcessFormOpen((current) => !current)}
            >
              {t("＋ Adicionar processo")}
            </button>
          </div>
          {processFormOpen && (
            <form className="process-definition-form" onSubmit={(event) => void addProcess(event)}>
              <label>
                {t("Process name")}
                <input value={processName} onChange={(event) => setProcessName(event.target.value)} placeholder="web" />
              </label>
              <label>
                {t("Comando")}
                <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="pnpm dev" />
              </label>
              <label>
                {t("CWD")}
                <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="." />
              </label>
              <label className="toggle-row">
                <span>
                  <strong>{t("Detectar porta HTTP automaticamente")}</strong>
                  <small>{t("O preview abre quando o processo anunciar uma porta local.")}</small>
                </span>
                <input type="checkbox" checked={autoDetect} onChange={(event) => setAutoDetect(event.target.checked)} />
              </label>
              {!autoDetect && (
                <label>
                  {t("Porta HTTP")}
                  <input
                    inputMode="numeric"
                    value={previewPort}
                    onChange={(event) => setPreviewPort(event.target.value)}
                    placeholder="4310"
                  />
                </label>
              )}
              <div className="env-secret-list">
                <div className="panel-heading-row">
                  <strong>{t("Env de secrets")}</strong>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setEnvRows((current) => [
                        ...current,
                        { id: `env-${Date.now()}-${current.length}`, key: "", secret: secrets[0]?.name ?? "" },
                      ])
                    }
                  >
                    {t("＋ adicionar")}
                  </button>
                </div>
                {envRows.map((row, index) => (
                  <div className="env-secret-row" key={row.id}>
                    <input
                      aria-label={`Nome da variável ${index + 1}`}
                      value={row.key}
                      onChange={(event) =>
                        setEnvRows((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)),
                        )
                      }
                      placeholder="API_URL"
                    />
                    <select
                      aria-label={`Secret da variável ${index + 1}`}
                      value={row.secret}
                      onChange={(event) =>
                        setEnvRows((current) =>
                          current.map((item) => (item.id === row.id ? { ...item, secret: event.target.value } : item)),
                        )
                      }
                    >
                      <option value="">{t("Escolha um secret")}</option>
                      {secrets.map((secret) => (
                        <option key={secret.id} value={secret.name}>
                          {secret.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {secrets.length === 0 && (
                  <small className="field-help">
                    {t("Salve secrets acima para injetá-los sem expor valores ao sidecar.")}
                  </small>
                )}
              </div>
              <div className="modal-actions">
                <button type="button" className="button button-quiet" onClick={() => setProcessFormOpen(false)}>
                  {t("Cancelar")}
                </button>
                <button
                  type="submit"
                  className="button button-brand"
                  disabled={savingProcess || !processName.trim() || !command.trim()}
                >
                  {savingProcess ? t("Adicionando…") : t("Adicionar processo")}
                </button>
              </div>
            </form>
          )}
          <div className="defined-process-list">
            {processes.map((entry) => {
              const status = entry.run?.status ?? "não iniciado"
              return (
                <article className="defined-process" key={entry.spec.id}>
                  <div>
                    <strong>{entry.spec.name}</strong>
                    <small>
                      {entry.spec.command} · {statusLabel(status)}
                    </small>
                  </div>
                  <div className="process-actions">
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void processAction("start", entry.spec.id)}
                    >
                      {t("Iniciar")}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void processAction("stop", entry.spec.id)}
                    >
                      {t("Parar")}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void processAction("restart", entry.spec.id)}
                    >
                      {t("Reiniciar")}
                    </button>
                    <button type="button" className="text-button" onClick={() => void loadProcessLogs(entry.spec.id)}>
                      Logs
                    </button>
                  </div>
                  {expandedLogs === entry.spec.id && (
                    <pre className="process-inline-logs">{logs[entry.spec.id]?.join("\n") || "aguardando logs"}</pre>
                  )}
                </article>
              )
            })}
            {processes.length === 0 && <p className="muted-copy">{t("Nenhum processo definido ainda.")}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>
              {t("Fechar")}
            </button>
            <button type="button" className="button button-brand" onClick={onOpenPreview}>
              {t("Abrir Preview")}
            </button>
          </div>
        </div>
      ) : null}
      {pickingFolder && (
        <FolderPicker
          api={api}
          invokeCommand={invokeCommand}
          onClose={() => setPickingFolder(false)}
          onSelect={(folder) => {
            changeSource(() => setPath(folder.path))
            setProjectFolder(folder)
            setPickingFolder(false)
          }}
        />
      )}
    </Modal>
  )
}

const BotSettingsLoading = () => <p role="status">{t("Loading")}</p>
