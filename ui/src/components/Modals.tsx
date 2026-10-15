import type {
  ApiRoutes,
  Bot,
  DoctorReport,
  EnvValue,
  MachineCapability,
  MachineState,
  ProcessSpec,
  Project,
  Routine,
  SecretMeta,
} from "@touri/contracts"
import { avatarProfileFor } from "@touri/contracts/avatar"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { readTheme, setTheme, type ThemePreference } from "../design/theme"
import { userFacingError } from "../errors"
import { CloudPreferences } from "../features/cloud/CloudPreferences"
import { useCloudAccount } from "../features/cloud/useCloudAccount"
import {
  APP_SETTINGS_SECTIONS,
  type AppSettingsSectionId,
  BOT_SETTINGS_SECTIONS,
  type BotSettingsSectionId,
  SETTINGS,
} from "../features/commandPalette/settingsRegistry"
import { paletteShortcutLabel } from "../features/commandPalette/shortcut"
import { useSettingFocus } from "../features/commandPalette/useSettingFocus"
import { ComputerUseSettings } from "../features/computer"
import { DoctorChecks } from "../features/doctor/DoctorChecks"
import { ReportProblem } from "../features/reports/ReportProblem"
import { plural, statusLabel, t } from "../i18n"
import type { WorkspaceActions } from "../useWorkspace"
import { type AvatarChoice, AvatarPicker } from "./AvatarPicker"
import { BotAvatar } from "./BotAvatar"
import { BotMcpSettings } from "./BotMcpSettings"
import { BotNetworkSettings } from "./BotNetworkSettings"
import { BotStandingGrants } from "./BotStandingGrants"
import { DeleteBotDialog } from "./DeleteBotDialog"
import { MachineFields } from "./MachineFields"
import { ProviderLogin } from "./ProviderLogin"
import { ProviderMark, providerName } from "./ProviderMark"
import { ProviderModelField } from "./ProviderModelField"
import { SecretsPanel } from "./RightPanels"
import { SettingsGroup, SettingsLayout, SettingsPane, SettingsRow, SettingsSwitch } from "./SettingsLayout"
import "./settings.css"
import { readInlinePreviewPreference, setInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"

type ModalProps = {
  onClose: () => void
  children: React.ReactNode
  title: string
  eyebrow?: string
  className?: string
}

export const Modal = ({ onClose, children, title, eyebrow = "touri", className = "" }: ModalProps) => {
  const cardRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef(document.activeElement)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const previous = returnFocusRef.current instanceof HTMLElement ? returnFocusRef.current : null
    if (!card.contains(document.activeElement))
      (
        card.querySelector<HTMLElement>("[data-initial-focus]") ?? card.querySelector<HTMLElement>(".modal-close")
      )?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (document.querySelectorAll(".modal-card").item(document.querySelectorAll(".modal-card").length - 1) !== card)
        return
      const confirmation = Array.from(card.querySelectorAll<HTMLElement>('[role="alertdialog"]')).find(
        (element) => !element.closest("[hidden]"),
      )
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        if (confirmation) confirmation.querySelector<HTMLButtonElement>(".button-quiet")?.click()
        else closeRef.current()
      }
      if (event.key !== "Tab") return
      const scope = confirmation ?? card
      const controls = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      ).filter((element) => !element.closest("[hidden]") && element.tabIndex >= 0)
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", handleKey, true)
    return () => {
      document.removeEventListener("keydown", handleKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div className="modal-backdrop" role="presentation">
      <section ref={cardRef} className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label={t("Close dialog")}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}

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

type BotCreateModalProps = {
  api?: UiApi
  cloudEnabled?: boolean
  capability?: MachineCapability
  projects?: Array<Project>
  onClose: () => void
  onCreate: (input: ApiRoutes["POST /bots"]["req"]) => Promise<void>
}

export const BotCreateModal = ({
  capability,
  projects = [],
  onClose,
  onCreate,
  api,
  cloudEnabled = false,
}: BotCreateModalProps) => {
  const { account: cloudAccount } = useCloudAccount(api, cloudEnabled)
  const [cloudApiKey, setCloudApiKey] = useState("")
  const [avatarSeed] = useState(() => crypto.randomUUID())
  const [avatar, setAvatar] = useState<AvatarChoice>(() => {
    const profile = avatarProfileFor({ id: avatarSeed, color: null })
    return { avatarShape: profile.shape, color: null }
  })
  const [name, setName] = useState("")
  const [roleLine, setRoleLine] = useState("")
  const [title, setTitle] = useState("")
  const [provider, setProvider] = useState<Bot["provider"]>("codex")
  const [instructions, setInstructions] = useState("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState<Bot["reasoningEffort"]>(null)
  const [projectId, setProjectId] = useState("")
  const [browserEnabled, setBrowserEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [access, setAccess] = useState("workspace-write")
  const [machine, setMachine] = useState<
    Pick<Bot, "machine" | "machineIdleMinutes" | "vmProviderLogin" | "hostComputerUse">
  >({ machine: "local", machineIdleMinutes: 10, vmProviderLogin: false, hostComputerUse: false })
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(0)
  const [furthestStep, setFurthestStep] = useState(0)
  const createContent = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const pane = createContent.current
    if (!pane) return
    pane.scrollTop = 0
    pane.querySelector<HTMLElement>(step === 0 ? "[data-initial-focus]" : "h3")?.focus({ preventScroll: true })
  }, [step])
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!name.trim() || saving) return
    if (invalidMachine) {
      goToStep(3)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCreate({
        name: name.trim(),
        roleLine: roleLine.trim() || null,
        title: title.trim() || null,
        provider,
        instructions,
        model: model.trim() || null,
        reasoningEffort: effort,
        projectId: projectId || null,
        browserEnabled,
        access: access === "full-approved" ? "full" : (access as Bot["access"]),
        approvals: access === "full" || (provider === "codex" && access === "full-approved") ? "never" : "on-request",
        avatarSeed,
        ...avatar,
        ...machine,
        ...(machine.machine === "cloud" ? { cloudApiKey } : {}),
      })
      onClose()
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      setSaving(false)
    }
  }
  const stepTitles = [
    "Nome e mascote",
    "Função e instruções",
    "Provedor e acesso",
    "Computador e integrações",
    "Revisar e criar",
  ]
  const goToStep = (next: number): void => {
    if (next > 3 && invalidMachine) return
    setStep(next)
    setFurthestStep((current) => Math.max(current, next))
    setError(null)
  }
  const invalidMachine =
    machine.machine === "vm" &&
    (!Number.isInteger(machine.machineIdleMinutes) ||
      machine.machineIdleMinutes < 1 ||
      machine.machineIdleMinutes > 1440)
  return (
    <Modal
      onClose={() => {
        if (!saving) onClose()
      }}
      title={t("Create a teammate")}
      eyebrow="novo bot"
      className="settings-modal bot-create-modal"
    >
      <form
        className="bot-create-form"
        onSubmit={(event) => {
          if (step < 4) {
            event.preventDefault()
            if (name.trim() && (step !== 3 || !invalidMachine)) goToStep(step + 1)
          } else void submit(event)
        }}
      >
        <nav className="bot-create-steps" aria-label="Etapas de criação">
          {stepTitles.map((label, index) => (
            <button
              key={label}
              type="button"
              aria-current={index === step ? "step" : undefined}
              disabled={index > furthestStep || saving || (index > 0 && !name.trim()) || (index > 3 && invalidMachine)}
              onClick={() => goToStep(index)}
            >
              <span aria-hidden="true">{index < step ? "✓" : index + 1}</span>
              {label}
            </button>
          ))}
        </nav>
        <div ref={createContent} className="bot-create-content">
          <div className="settings-pane-heading">
            <h3 tabIndex={-1}>{stepTitles[step]}</h3>
            <p>
              {
                [
                  "Dê um nome ao seu bot e escolha como ele aparece na equipe.",
                  "Defina o trabalho, o contexto e o jeito de responder.",
                  "Escolha quem executa as tarefas e o nível de acesso.",
                  "Defina onde o bot trabalha e quais recursos ele pode usar.",
                  "Confira as escolhas. Você pode voltar para editar antes de criar.",
                ][step]
              }
            </p>
          </div>
          {step === 0 && (
            <div className="bot-create-fields">
              <label htmlFor="bot-name">{t("Name")}</label>
              <input
                id="bot-name"
                data-initial-focus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("e.g. dev")}
              />
              <AvatarPicker
                bot={{ id: avatarSeed, avatarSeed, ...avatar }}
                onChange={(choice) => setAvatar((current) => ({ ...current, ...choice }))}
              />
            </div>
          )}
          {step === 1 && (
            <div className="bot-create-fields">
              <label htmlFor="bot-role">{t("Função")}</label>
              <input id="bot-role" value={roleLine} onChange={(event) => setRoleLine(event.target.value)} />
              <label htmlFor="bot-title">{t("Título (opcional)")}</label>
              <input id="bot-title" value={title} onChange={(event) => setTitle(event.target.value)} />
              <label htmlFor="create-soul">SOUL.md</label>
              <textarea
                id="create-soul"
                rows={5}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Descreva o papel, as tarefas e o estilo deste bot."
              />
            </div>
          )}
          {step === 2 && (
            <div className="bot-create-fields">
              <label htmlFor="bot-provider">{t("Provider")}</label>
              <select
                id="bot-provider"
                value={provider}
                onChange={(event) => {
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
              <label htmlFor="create-model">{t("Model")}</label>
              <ProviderMark provider={provider} />
              <ProviderModelField id="create-model" api={api} provider={provider} value={model} onChange={setModel} />
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
              {provider === "codex" && (
                <p>
                  Com acesso total, o Codex executa sem pedir aprovação e sem sandbox. O modo somente leitura mantém o
                  sandbox. As políticas MCP e de controle do computador continuam valendo.
                </p>
              )}
              {access === "full" && (
                <div className="warning-callout">
                  {t("Full access lets the CLI write anywhere. Use it only for a teammate you trust.")}
                </div>
              )}
            </div>
          )}
          {step === 3 && (
            <div className="bot-create-fields">
              <label htmlFor="create-project">{t("Projeto")}</label>
              <select
                id="create-project"
                disabled={machine.machine === "cloud"}
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">{t("Somente pasta do bot")}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <label className="toggle-row" htmlFor="create-browser">
                <span>{t("Browser enabled")}</span>
                <SettingsSwitch
                  id="create-browser"
                  checked={browserEnabled}
                  onChange={(event) => setBrowserEnabled(event.target.checked)}
                />
              </label>
              <MachineFields
                values={machine}
                cloudConnected={cloudAccount?.connected === true}
                provider={provider}
                {...(capability ? { capability } : {})}
                onChange={(patch) => {
                  setMachine((current) => ({ ...current, ...patch }))
                  if (patch.machine === "cloud") setProjectId("")
                }}
              />
              {machine.machine === "cloud" && (
                <>
                  <label htmlFor="cloud-api-key">
                    Chave API do{" "}
                    {provider === "opencode" ? "OpenRouter" : provider === "codex" ? "OpenAI" : "Anthropic"}
                  </label>
                  <input
                    id="cloud-api-key"
                    type="password"
                    autoComplete="off"
                    value={cloudApiKey}
                    onChange={(event) => setCloudApiKey(event.target.value)}
                  />
                  <p className="field-help">
                    O runtime inteiro roda na nuvem, com o Mac desligado. Sua chave é enviada somente ao serviço
                    conectado. O modelo é cobrado pelo provedor. Sandbox sem cobrança real.
                  </p>
                </>
              )}
              {invalidMachine && (
                <p role="alert" className="warning-callout">
                  Escolha de 1 a 1.440 minutos sem atividade.
                </p>
              )}
              <div className="settings-inline-note">
                <strong>Integrações MCP</strong>
                <p>
                  Depois de criar, conecte os servidores na seção MCP das configurações deste bot. Cada conexão fica
                  vinculada ao bot.
                </p>
              </div>
            </div>
          )}
          {step === 4 && (
            <div className="bot-create-review">
              <div className="bot-create-identity">
                <BotAvatar bot={{ id: avatarSeed, avatarSeed, ...avatar }} size={64} mood="idle" />
                <div>
                  <strong>{name.trim()}</strong>
                  <p>{roleLine.trim() || "Função ainda não definida"}</p>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Provedor e modelo</dt>
                  <dd>
                    {providerName(provider)} · {model.trim() || "Padrão do provedor"}
                  </dd>
                </div>
                <div>
                  <dt>Acesso</dt>
                  <dd>
                    {access === "read-only"
                      ? "Somente leitura"
                      : access === "workspace-write"
                        ? t("Workspace write · approvals")
                        : access === "full-approved" && provider !== "codex"
                          ? "Acesso total com aprovação"
                          : "Acesso completo"}
                  </dd>
                </div>
                <div>
                  <dt>Computador</dt>
                  <dd>
                    {machine.machine === "cloud"
                      ? "Na nuvem · chave API própria"
                      : machine.machine === "vm"
                        ? `Linux isolado · pausa após ${machine.machineIdleMinutes} ${plural(machine.machineIdleMinutes, "minuto", "minutos")}`
                        : "Este computador"}
                  </dd>
                </div>
                <div>
                  <dt>Raciocínio</dt>
                  <dd>
                    {effort === "low"
                      ? t("Low")
                      : effort === "medium"
                        ? t("Medium")
                        : effort === "high"
                          ? t("High")
                          : effort === "xhigh"
                            ? t("Extra high")
                            : t("Padrão do provedor")}
                  </dd>
                </div>
                <div>
                  <dt>Projeto</dt>
                  <dd>{projects.find((project) => project.id === projectId)?.name ?? "Somente pasta do bot"}</dd>
                </div>
                <div>
                  <dt>Navegador</dt>
                  <dd>{browserEnabled ? "Ativado" : "Desativado"}</dd>
                </div>
                {machine.machine === "vm" && (
                  <>
                    <div>
                      <dt>Login na VM</dt>
                      <dd>{machine.vmProviderLogin ? "Usar login do provedor" : "Não compartilhar login"}</dd>
                    </div>
                    <div>
                      <dt>Controle do Mac</dt>
                      <dd>{machine.hostComputerUse ? "Permitido com autorização temporária" : "Desativado"}</dd>
                    </div>
                  </>
                )}
              </dl>
              <div className="settings-inline-note">
                <strong>Instruções · SOUL.md</strong>
                <p className="bot-create-soul-preview">
                  {instructions.trim() || "Você pode adicionar instruções nas configurações quando quiser."}
                </p>
              </div>
            </div>
          )}
          {error && (
            <p className="warning-callout" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <span className="bot-create-progress">Etapa {step + 1} de 5</span>
          <button
            type="button"
            className="button button-quiet"
            disabled={saving}
            onClick={() => (step === 0 ? onClose() : goToStep(step - 1))}
          >
            {step === 0 ? t("Cancel") : t("Back")}
          </button>
          <button
            type="submit"
            className="button button-brand"
            disabled={
              !name.trim() ||
              saving ||
              (step >= 3 && (invalidMachine || (machine.machine === "cloud" && !cloudApiKey.trim())))
            }
          >
            {step < 4 ? t("Continue") : saving ? t("Creating…") : t("Create teammate")}
          </button>
        </div>
      </form>
    </Modal>
  )
}

type BotSettingsModalProps = {
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
  bot: Bot
  projects: Array<Project>
  routines: Array<Routine>
  actions: WorkspaceActions
  onClose: () => void
}

export const BotSettingsModal = ({
  focusMcp = false,
  permissionsOnly = false,
  api,
  bot,
  projects,
  routines,
  actions,
  onClose,
  capability,
  machineState,
  activeTurns = false,
  onOpenIntegrations,
  initialSection,
  focusSetting,
}: BotSettingsModalProps) => {
  const [avatar, setAvatar] = useState<AvatarChoice>(() => {
    const profile = avatarProfileFor(bot)
    return { avatarShape: profile.shape, color: bot.color }
  })
  const [roleLine, setRoleLine] = useState(bot.roleLine ?? "")
  const [title, setTitle] = useState(bot.title ?? "")
  const [deleting, setDeleting] = useState(false)
  const [instructions, setInstructions] = useState(bot.instructions)
  const [machine, setMachine] = useState<
    Pick<Bot, "machine" | "machineIdleMinutes" | "vmProviderLogin" | "hostComputerUse">
  >({
    machine: bot.machine,
    machineIdleMinutes: bot.machineIdleMinutes,
    vmProviderLogin: bot.vmProviderLogin,
    hostComputerUse: bot.hostComputerUse,
  })
  const [provider, setProvider] = useState(bot.provider)
  const [model, setModel] = useState(bot.model ?? "")
  const [access, setAccess] = useState<string>(
    bot.provider !== "codex" && bot.access === "full" && bot.approvals === "on-request" ? "full-approved" : bot.access,
  )
  const [effort, setEffort] = useState<Bot["reasoningEffort"]>(bot.reasoningEffort)
  const [projectId, setProjectId] = useState(bot.projectId ?? "")
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
    initialSection ?? (focusMcp ? "mcp" : permissionsOnly ? "permissions" : "general"),
  )
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
      setSaveError("Escolha de 1 a 1.440 minutos sem atividade.")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await actions.updateBot(bot.id, {
        ...avatar,
        ...machine,
        roleLine: roleLine.trim() || null,
        title: title.trim() || null,
        instructions,
        provider,
        model: model || null,
        access: access === "full-approved" ? "full" : (access as Bot["access"]),
        approvals: access === "full" || (provider === "codex" && access === "full-approved") ? "never" : "on-request",
        reasoningEffort: effort,
        projectId: projectId || null,
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
  return (
    <Modal
      onClose={onClose}
      title={permissionsOnly ? t("Permissões do bot") : t("Bot settings", { name: bot.name })}
      eyebrow="configuração do bot"
      className="settings-modal"
    >
      <SettingsLayout
        sections={sections}
        active={section}
        onChange={setSection}
        label="Seções das configurações do bot"
      >
        <SettingsPane {...botPane("general")}>
          <SettingsGroup title="Identidade">
            <SettingsRow title="Função" description="Um resumo do trabalho do bot na equipe." htmlFor="settings-role">
              <input id="settings-role" value={roleLine} onChange={(event) => setRoleLine(event.target.value)} />
            </SettingsRow>
            <SettingsRow
              title="Título (opcional)"
              description="Uma identificação curta para este bot."
              htmlFor="settings-title"
            >
              <input id="settings-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </SettingsRow>
            <div className="settings-avatar-field">
              <AvatarPicker
                bot={{ ...bot, ...avatar }}
                onChange={(choice) => setAvatar((current) => ({ ...current, ...choice }))}
              />
            </div>
          </SettingsGroup>
          <SettingsGroup title="Provedor e modelo">
            <SettingsRow
              title={t("Provider")}
              description="O programa que executa as tarefas deste bot."
              htmlFor="settings-provider"
            >
              <select
                id="settings-provider"
                value={provider}
                onChange={(event) => {
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
              description="Deixe em branco para usar o padrão do provedor."
              htmlFor="settings-model"
            >
              <ProviderMark provider={provider} />
              <ProviderModelField
                id="settings-model"
                api={api}
                botId={bot.id}
                provider={provider}
                value={model}
                onChange={setModel}
              />
            </SettingsRow>
            <SettingsRow
              title={t("Reasoning")}
              description="A profundidade de raciocínio nas próximas tarefas."
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
          <SettingsGroup title="Instruções">
            <section>
              <label htmlFor="soul">SOUL.md</label>
              <textarea
                id="soul"
                className="soul-editor"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
              <small className="field-help">
                {t("Applied on the next turn. The file is mirrored in this bot’s home.")}
              </small>
              {instructions.includes("coordinate_bots") && (
                <p className="warning-callout">
                  A SOUL menciona coordinate_bots, mas essa ferramenta não está disponível no touri. Para coordenar o
                  trabalho, abra cada bot em Bots e envie a tarefa; conecte um servidor MCP próprio se precisar de
                  coordenação automática.
                </p>
              )}
            </section>
          </SettingsGroup>
          <SettingsGroup title="Excluir bot">
            <p>Remove este bot, suas conversas, rotinas e seu computador.</p>
            <button
              type="button"
              className="tool-action tool-action-deny"
              disabled={saving || updating}
              onClick={() => setDeleting(true)}
            >
              Excluir bot
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
              onChange={(patch) => setMachine((current) => ({ ...current, ...patch }))}
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
            {api && bot.machine === "vm" && <BotNetworkSettings api={api} botId={bot.id} />}
            {api && machine.machine === "vm" && (
              <ProviderLogin
                key={provider}
                api={api}
                botId={bot.id}
                provider={provider}
                onConfigured={() => setMachine((current) => ({ ...current, vmProviderLogin: true }))}
              />
            )}
          </SettingsGroup>
          <SettingsGroup title="Arquivos e navegador">
            <div className="settings-fields">
              <label>
                {t("Projeto")}
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">{t("Somente pasta do bot")}</option>
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-row" htmlFor="settings-browser">
                <span>
                  <strong>{t("Browser enabled")}</strong>
                  <small>{t("Allow this teammate to use its touri-owned Chrome tabs.")}</small>
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
            </div>
          </SettingsGroup>
        </SettingsPane>
        <SettingsPane {...botPane("permissions")}>
          <SettingsGroup title="Nível de acesso">
            <div className="settings-fields">
              <label>
                {t("Access")}
                <select
                  ref={permissionsRef}
                  value={provider === "codex" && access === "full-approved" ? "full" : access}
                  onChange={(event) => setAccess(event.target.value as Bot["access"])}
                >
                  <option value="read-only">{t("Read-only")}</option>
                  <option value="workspace-write">{t("Workspace write")}</option>
                  <option value="full">{t("Full access")}</option>
                  {provider !== "codex" && <option value="full-approved">{t("Acesso total com aprovação")}</option>}
                </select>
              </label>
              {provider === "codex" && (
                <p>
                  Com acesso total, o Codex executa sem pedir aprovação e sem sandbox. O modo somente leitura mantém o
                  sandbox. As políticas MCP e de controle do computador continuam valendo.
                </p>
              )}
              {access === "full" && (
                <div className="warning-callout">{t("Full access bypasses the normal workspace boundary.")}</div>
              )}
              {api && <BotStandingGrants key={grantsRevision} api={api} botId={bot.id} />}
            </div>
          </SettingsGroup>
          <SettingsGroup title="Controle do computador">
            <label className="toggle-row" htmlFor="settings-computer-use">
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
        </SettingsPane>
        <SettingsPane {...botPane("mcp")}>
          {api && (
            <BotMcpSettings
              api={api}
              botId={bot.id}
              onPermissionsChange={() => setGrantsRevision((revision) => revision + 1)}
              focusOnOpen={focusMcp}
              {...(onOpenIntegrations ? { onOpenIntegrations } : {})}
            />
          )}
        </SettingsPane>
        <SettingsPane {...botPane("routines")}>
          <SettingsGroup title={`${botRoutines.length} ${plural(botRoutines.length, "rotina", "rotinas")}`}>
            <section>
              {botRoutines.map((routine) => (
                <div className="routine-row" key={routine.id}>
                  <span>
                    <strong>{routine.name}</strong>
                    <small>
                      {routine.cron} · {routine.timezone}
                    </small>
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
      {saveError && (
        <p className="settings-save-error warning-callout" role="alert">
          {saveError}
        </p>
      )}
      <div className="modal-actions">
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
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/")}`

export const ProjectModal = ({
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

  const changeSource = (change: () => void) => {
    change()
    setConnectedProject(null)
    setProjectGit(null)
    setProjectError(null)
    setReturnedExisting(null)
  }

  const chooseFolder = async (): Promise<void> => {
    const selected = await invokeCommand("pick_folder", { title: t("Connect a project folder") })
    const selectedPath = selected?.path
    if (selectedPath) changeSource(() => setPath(selectedPath))
  }

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

  const connect = async (useExisting?: Project): Promise<void> => {
    if (savingProject) return
    if (source === "folder" && !path.trim()) return
    if (source === "clone" && (!gitUrl.trim() || !parentDir.trim())) return
    setSavingProject(true)
    setProjectError(null)
    try {
      if (source === "folder" && !connectedProject && !useExisting) {
        const result = await api.request("GET /projects", {})
        setKnownProjects(result.projects)
        const existing = result.projects.find((item) => folderKey(item.path) === folderKey(path))
        if (existing) {
          setReturnedExisting(existing)
          return
        }
      }
      const input: ApiRoutes["POST /projects"]["req"] =
        source === "folder"
          ? { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }
          : {
              gitUrl: gitUrl.trim(),
              parentDir: parentDir.trim(),
              ...(name.trim() ? { name: name.trim() } : {}),
            }
      const nextProject = connectedProject ?? useExisting ?? (await actions.createProject(input))
      // The sidecar canonicalizes paths (including symlinks) and may return an existing project.
      // Keep the form and requested name until the user explicitly accepts that project.
      if (!connectedProject && !useExisting && source === "folder" && name.trim() && nextProject.name !== name.trim()) {
        setReturnedExisting(nextProject)
        return
      }
      setConnectedProject(nextProject)
      await Promise.all(selectedBotIds.map((botId) => actions.updateBot(botId, { projectId: nextProject.id })))
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
          actions.updateBot(bot.id, { projectId: selectedBotIds.includes(bot.id) ? connectedProject.id : null }),
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
              <small className="field-help">
                {t("No navegador, digite o caminho. No app Tauri, use o seletor nativo.")}
              </small>
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
            onChange={(event) => changeSource(() => setName(event.target.value))}
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
                  disabled={savingProject}
                  checked={selectedBotIds.includes(bot.id)}
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
                  checked={selectedBotIds.includes(bot.id)}
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
    </Modal>
  )
}

type SettingsModalProps = {
  initialSection?: string
  /** Registry setting id to focus and highlight once the dialog opens (command palette). */
  focusSetting?: string | null
  reportErrorCode?: string | undefined
  invokeCommand?: TauriInvoke
  api?: UiApi
  settings: ApiRoutes["GET /settings"]["res"]["settings"] | null
  onClose: () => void
  onSave: (patch: Partial<ApiRoutes["PATCH /settings"]["req"]>) => Promise<void>
}

export const SettingsModal = ({
  settings,
  onClose,
  onSave,
  api,
  invokeCommand,
  initialSection,
  reportErrorCode,
  focusSetting,
}: SettingsModalProps) => {
  const [section, setSection] = useState(initialSection ?? "appearance")
  useSettingFocus(focusSetting)
  const [theme, setThemePreference] = useState<ThemePreference>(readTheme)
  const [inlinePreview, setInlinePreview] = useState(readInlinePreviewPreference)
  const [telemetry, setTelemetry] = useState(settings?.cliTelemetry ?? "off")
  const [updates, setUpdates] = useState(settings?.checkForUpdates ?? false)
  const [tray, setTray] = useState(settings?.keepRunningInTray ?? true)
  const [native, setNative] = useState(settings?.nativeNotifications ?? true)
  const [floatUpdates, setFloatUpdates] = useState(settings?.sidebarFloatUpdates ?? true)
  const [resumeTurns, setResumeTurns] = useState(settings?.resumeInterruptedTurns ?? true)
  const [vmMemory, setVmMemory] = useState(settings?.botVmMemoryMb ?? 1536)
  const [retentionDays, setRetentionDays] = useState(settings?.dataRetentionDays ?? 30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (saving) return
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      setError("Escolha de 0 a 3.650 dias para guardar os detalhes.")
      setSection("privacy")
      return
    }
    if (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384) {
      setError("Escolha de 512 a 16.384 MiB por computador do bot.")
      setSection("general")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        cliTelemetry: telemetry,
        checkForUpdates: updates,
        keepRunningInTray: tray,
        nativeNotifications: native,
        sidebarFloatUpdates: floatUpdates,
        resumeInterruptedTurns: resumeTurns,
        botVmMemoryMb: vmMemory,
        dataRetentionDays: retentionDays,
      })
      setTheme(theme)
      setInlinePreviewPreference(inlinePreview)
      onClose()
    } catch (caught) {
      setError(userFacingError(caught))
    } finally {
      setSaving(false)
    }
  }
  const sections = APP_SETTINGS_SECTIONS.filter((entry) => entry.id !== "cloud" || (settings?.cloud && api))
  const pane = (id: AppSettingsSectionId) => {
    const entry = APP_SETTINGS_SECTIONS.find((candidate) => candidate.id === id)
    return { active: section, id, title: entry?.label ?? id, description: entry?.description ?? "" }
  }
  return (
    <Modal onClose={onClose} title={t("Settings")} eyebrow={t("Local preferences")} className="settings-modal">
      <SettingsLayout sections={sections} active={section} onChange={setSection} label="Seções das preferências">
        <SettingsPane {...pane("report")}>
          {section === "report" && (
            <ReportProblem api={api} invokeCommand={invokeCommand} errorCode={reportErrorCode} />
          )}
        </SettingsPane>
        {settings?.cloud && api && (
          <SettingsPane {...pane("cloud")}>
            <CloudPreferences api={api} settings={settings} onSave={onSave} />
          </SettingsPane>
        )}
        <SettingsPane {...pane("appearance")}>
          <SettingsGroup>
            <SettingsRow
              title={SETTINGS.theme.label}
              description={SETTINGS.theme.description}
              htmlFor={SETTINGS.theme.controlId}
              settingId={SETTINGS.theme.id}
            >
              <select
                id={SETTINGS.theme.controlId}
                value={theme}
                onChange={(event) => setThemePreference(event.target.value as ThemePreference)}
              >
                <option value="dark">Escuro</option>
                <option value="light">Claro</option>
                <option value="system">Sistema</option>
              </select>
            </SettingsRow>
            <SettingsRow
              title={SETTINGS.inlinePreview.label}
              description={SETTINGS.inlinePreview.description}
              htmlFor={SETTINGS.inlinePreview.controlId}
              settingId={SETTINGS.inlinePreview.id}
            >
              <SettingsSwitch
                id={SETTINGS.inlinePreview.controlId}
                checked={inlinePreview}
                onChange={(event) => setInlinePreview(event.target.checked)}
              />
            </SettingsRow>
            <SettingsRow
              title={SETTINGS.sidebarFloatUpdates.label}
              description={SETTINGS.sidebarFloatUpdates.description}
              htmlFor={SETTINGS.sidebarFloatUpdates.controlId}
              settingId={SETTINGS.sidebarFloatUpdates.id}
            >
              <SettingsSwitch
                id={SETTINGS.sidebarFloatUpdates.controlId}
                checked={floatUpdates}
                onChange={(event) => setFloatUpdates(event.target.checked)}
              />
            </SettingsRow>
          </SettingsGroup>
        </SettingsPane>
        <SettingsPane {...pane("shortcuts")}>
          <SettingsGroup>
            <SettingsRow
              title={SETTINGS.shortcutPalette.label}
              description={SETTINGS.shortcutPalette.description}
              settingId={SETTINGS.shortcutPalette.id}
            >
              <kbd>{paletteShortcutLabel()}</kbd>
            </SettingsRow>
            <SettingsRow
              title={SETTINGS.shortcutSend.label}
              description={SETTINGS.shortcutSend.description}
              settingId={SETTINGS.shortcutSend.id}
            >
              <kbd>Enter</kbd>
            </SettingsRow>
          </SettingsGroup>
          <div className="settings-note">
            <div>
              <span>{t("Computer-use hotkey:")}</span>
              <code>{settings?.computerUseHotkey ?? "⌃⌥⌘."}</code>
            </div>
          </div>
        </SettingsPane>
        <SettingsPane {...pane("privacy")}>
          <SettingsGroup>
            <SettingsRow
              title={SETTINGS.telemetry.label}
              description={SETTINGS.telemetry.description}
              htmlFor={SETTINGS.telemetry.controlId}
              settingId={SETTINGS.telemetry.id}
            >
              <select
                id={SETTINGS.telemetry.controlId}
                value={telemetry}
                onChange={(event) => setTelemetry(event.target.value as "off" | "cli-default")}
              >
                <option value="off">{t("Off (recommended)")}</option>
                <option value="cli-default">{t("CLI default")}</option>
              </select>
            </SettingsRow>
            <SettingsRow
              title={SETTINGS.retention.label}
              description={SETTINGS.retention.description}
              htmlFor={SETTINGS.retention.controlId}
              settingId={SETTINGS.retention.id}
            >
              <input
                id={SETTINGS.retention.controlId}
                type="number"
                min={0}
                max={3650}
                step={1}
                value={retentionDays}
                onChange={(event) => setRetentionDays(Number(event.target.value))}
              />
              <span>dias</span>
            </SettingsRow>
          </SettingsGroup>
          <div className="settings-note">
            <div>
              <span>{t("Browser:")}</span>
              <code>
                {!settings?.browserExecutable || settings.browserExecutable === "system-chrome"
                  ? "Chrome do sistema"
                  : settings.browserExecutable}
              </code>
            </div>
          </div>
          <ComputerUseSettings className="settings-computer-permissions" />
        </SettingsPane>
        <SettingsPane {...pane("notifications")}>
          <SettingsGroup>
            <label
              className="toggle-row"
              htmlFor={SETTINGS.nativeNotifications.controlId}
              data-setting-id={SETTINGS.nativeNotifications.id}
            >
              <span>
                <strong>{SETTINGS.nativeNotifications.label}</strong>
                <small>{SETTINGS.nativeNotifications.description}</small>
              </span>
              <SettingsSwitch
                id={SETTINGS.nativeNotifications.controlId}
                checked={native}
                onChange={(event) => setNative(event.target.checked)}
              />
            </label>
          </SettingsGroup>
        </SettingsPane>
        <SettingsPane {...pane("general")}>
          <SettingsGroup>
            <label
              className="toggle-row"
              htmlFor={SETTINGS.checkForUpdates.controlId}
              data-setting-id={SETTINGS.checkForUpdates.id}
            >
              <span>
                <strong>{SETTINGS.checkForUpdates.label}</strong>
                <small>{SETTINGS.checkForUpdates.description}</small>
              </span>
              <SettingsSwitch
                id={SETTINGS.checkForUpdates.controlId}
                checked={updates}
                onChange={(event) => setUpdates(event.target.checked)}
              />
            </label>
            <SettingsRow
              title={SETTINGS.vmMemory.label}
              description={SETTINGS.vmMemory.description}
              htmlFor={SETTINGS.vmMemory.controlId}
              settingId={SETTINGS.vmMemory.id}
            >
              <input
                id={SETTINGS.vmMemory.controlId}
                type="number"
                min={512}
                max={16384}
                value={vmMemory}
                onChange={(event) => setVmMemory(Number(event.target.value))}
              />
            </SettingsRow>
            <label
              className="toggle-row"
              htmlFor={SETTINGS.resumeInterruptedTurns.controlId}
              data-setting-id={SETTINGS.resumeInterruptedTurns.id}
            >
              <span>
                <strong>{SETTINGS.resumeInterruptedTurns.label}</strong>
                <small>{SETTINGS.resumeInterruptedTurns.description}</small>
              </span>
              <SettingsSwitch
                id={SETTINGS.resumeInterruptedTurns.controlId}
                checked={resumeTurns}
                onChange={(event) => setResumeTurns(event.target.checked)}
              />
            </label>
            <label className="toggle-row" htmlFor={SETTINGS.tray.controlId} data-setting-id={SETTINGS.tray.id}>
              <span>
                <strong>{SETTINGS.tray.label}</strong>
                <small>{SETTINGS.tray.description}</small>
              </span>
              <SettingsSwitch
                id={SETTINGS.tray.controlId}
                checked={tray}
                onChange={(event) => setTray(event.target.checked)}
              />
            </label>
          </SettingsGroup>
        </SettingsPane>
      </SettingsLayout>
      {error && (
        <p className="settings-save-error warning-callout" role="alert">
          {error}
        </p>
      )}
      {section !== "report" && (
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className="button button-brand" disabled={saving} onClick={() => void save()}>
            {saving ? t("Saving…") : t("Save preferences")}
          </button>
        </div>
      )}
    </Modal>
  )
}
