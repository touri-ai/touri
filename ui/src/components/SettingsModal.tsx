import type { ApiRoutes, DoctorReport, NotificationPreferences } from "@touri/contracts"
import { lazy, Suspense, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { readTheme, setTheme, type ThemePreference } from "../design/theme"
import { userFacingError } from "../errors"
import {
  APP_SETTINGS_SECTIONS,
  type AppSettingsSectionId,
  SERVER_SETTINGS_SECTION,
  SETTINGS,
  WORK_SETTINGS_SECTION,
} from "../features/commandPalette/settingsRegistry"
import { paletteShortcutLabel } from "../features/commandPalette/shortcut"
import { useSettingFocus } from "../features/commandPalette/useSettingFocus"
import { ComputerUseSettings } from "../features/computer"
import { readInlinePreviewPreference, setInlinePreviewPreference } from "../features/desktop/inlinePreviewPreference"
import { DoctorChecks } from "../features/doctor/DoctorChecks"
import { ReportProblem } from "../features/reports/ReportProblem"
import { isNativeDesktop, useIsServerMode } from "../features/server/serverMode"
import { getHostLabel, t } from "../i18n"
import { hostComputerSupported } from "../platform"
import { useHost } from "../useHost"
import { Disclosure } from "./Disclosure"
import { Modal } from "./Modal"
import {
  SettingsDisclosure,
  SettingsGroup,
  SettingsLayout,
  SettingsPane,
  SettingsRow,
  SettingsSwitch,
} from "./SettingsLayout"

const NotificationPreferencesSettings = lazy(() =>
  import("./NotificationPreferencesSettings").then((module) => ({ default: module.NotificationPreferencesSettings })),
)
const ApiModelsSettings = lazy(() =>
  import("./ApiModelsSettings").then((module) => ({ default: module.ApiModelsSettings })),
)
const NotificationDeliverySettings = lazy(() =>
  import("./NotificationDeliverySettings").then((module) => ({ default: module.NotificationDeliverySettings })),
)
const CloudPreferences = lazy(() =>
  import("../features/cloud/CloudPreferences").then((module) => ({ default: module.CloudPreferences })),
)
const ServerModeSettings = lazy(() =>
  import("../features/server/ServerModeSettings").then((module) => ({ default: module.ServerModeSettings })),
)
const WorkAccessSettings = lazy(() =>
  import("../features/work/WorkAccessSettings").then((module) => ({ default: module.WorkAccessSettings })),
)

type SettingsModalProps = {
  doctor?: DoctorReport | null
  doctorError?: string | null
  onRefreshDoctor?: () => Promise<void>
  onImport?: () => void
  initialSection?: string
  /** Registry setting id to focus and highlight once the dialog opens (command palette). */
  focusSetting?: string | null
  reportErrorCode?: string | undefined
  invokeCommand?: TauriInvoke | undefined
  serverConnectionErrorCode?: string | null | undefined
  api?: UiApi | undefined
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
  doctor,
  doctorError,
  onRefreshDoctor,
  onImport,
  serverConnectionErrorCode,
}: SettingsModalProps) => {
  const host = useHost(api)
  const serverMode = useIsServerMode()
  const [section, setSection] = useState(
    initialSection === "report" || initialSection === "general"
      ? "diagnostics"
      : initialSection === "cloud"
        ? "privacy"
        : initialSection === "shortcuts"
          ? "appearance"
          : (initialSection ?? "appearance"),
  )
  useSettingFocus(focusSetting)
  const [reportOpen, setReportOpen] = useState(initialSection === "report")
  const [theme, setThemePreference] = useState<ThemePreference>(readTheme)
  const [inlinePreview, setInlinePreview] = useState(readInlinePreviewPreference)
  const [telemetry, setTelemetry] = useState(settings?.cliTelemetry ?? "off")
  const [updates, setUpdates] = useState(settings?.checkForUpdates ?? false)
  const [launchAtLogin, setLaunchAtLogin] = useState(settings?.launchAtLogin ?? false)
  const [tray, setTray] = useState(settings?.keepRunningInTray ?? true)
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences>(
    settings?.notificationPreferences ?? {},
  )
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
      setError(t("Escolha de 0 a 3.650 dias para guardar os detalhes."))
      setSection("privacy")
      return
    }
    if (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384) {
      setError(t("Escolha de 512 a 16.384 MiB por computador do bot."))
      setSection("diagnostics")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({
        ...(launchAtLogin !== (settings?.launchAtLogin ?? false) ? { launchAtLogin } : {}),
        cliTelemetry: telemetry,
        checkForUpdates: updates,
        keepRunningInTray: tray,
        nativeNotifications: native,
        notificationPreferences,
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
  const sections = [
    ...APP_SETTINGS_SECTIONS,
    ...(serverMode || (api && !api.isMock && !isNativeDesktop()) ? [WORK_SETTINGS_SECTION] : []),
    ...(isNativeDesktop() ? [SERVER_SETTINGS_SECTION] : []),
  ]
  const pane = (id: AppSettingsSectionId) => {
    const entry = sections.find((candidate) => candidate.id === id)
    return { active: section, id, title: entry?.label ?? id, description: entry?.description ?? "" }
  }
  return (
    <Modal onClose={onClose} title={t("Settings")} eyebrow={t("Local preferences")} className="settings-modal">
      <SettingsLayout sections={sections} active={section} onChange={setSection} label={t("Seções das preferências")}>
        <SettingsPane
          active={section}
          id="api-models"
          title={t("API models")}
          description={t("Choose a provider and use your own API key.")}
        >
          <Suspense fallback={<SettingsPaneLoading />}>
            <ApiModelsSettings api={api} />
          </Suspense>
        </SettingsPane>
        <SettingsPane {...pane("work")}>
          <Suspense fallback={<SettingsPaneLoading />}>
            <WorkAccessSettings api={api} />
          </Suspense>
        </SettingsPane>
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
                <option value="dark">{t("Escuro")}</option>
                <option value="light">{t("Claro")}</option>
                <option value="system">{t("Sistema")}</option>
              </select>
            </SettingsRow>
          </SettingsGroup>
          <SettingsDisclosure
            title={t("Chat, barra lateral e atalhos")}
            description={t("Ajuste as prévias, a ordem dos bots e veja as teclas rápidas.")}
            defaultOpen={initialSection === "shortcuts"}
          >
            <SettingsGroup>
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
          </SettingsDisclosure>
        </SettingsPane>
        <SettingsPane {...pane("privacy")}>
          <p className="field-help">
            {host === "server"
              ? t("Seus dados e os logins dos bots ficam no servidor escolhido.")
              : t("Your data stays on this {host}. External connections are optional.", { host: getHostLabel(host) })}
          </p>
          <SettingsDisclosure
            title={t("Dados, permissões e conexões")}
            description={t("Escolha o que guardar e o que os bots podem usar.")}
            defaultOpen={
              initialSection === "cloud" ||
              Boolean(error && (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650))
            }
          >
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
                <span>{t("dias")}</span>
              </SettingsRow>
            </SettingsGroup>
            <div className="settings-note">
              <div>
                <span>{t("Browser:")}</span>
                <code>
                  {!settings?.browserExecutable || settings.browserExecutable === "system-chrome"
                    ? t("Chrome do sistema")
                    : settings.browserExecutable}
                </code>
              </div>
            </div>
            {!serverMode && hostComputerSupported && <ComputerUseSettings className="settings-computer-permissions" />}
            {settings?.cloud && api && (
              <Suspense fallback={<SettingsPaneLoading />}>
                <CloudPreferences api={api} settings={settings} onSave={onSave} />
              </Suspense>
            )}
          </SettingsDisclosure>
        </SettingsPane>
        <SettingsPane {...pane("updates")}>
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
          </SettingsGroup>
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
            <Suspense fallback={<SettingsPaneLoading />}>
              <NotificationDeliverySettings enabled={native} />
            </Suspense>
          </SettingsGroup>
          <SettingsDisclosure
            title={t("Escolher avisos e horário silencioso")}
            description={t("Filtre por bot e tipo, incluindo resultados concluídos.")}
          >
            {(open) =>
              open && (
                <Suspense fallback={<SettingsPaneLoading />}>
                  <NotificationPreferencesSettings
                    value={notificationPreferences}
                    onChange={setNotificationPreferences}
                    api={api}
                  />
                </Suspense>
              )
            }
          </SettingsDisclosure>
        </SettingsPane>
        <SettingsPane {...pane("diagnostics")}>
          <SettingsDisclosure
            title={t("Verificar e cuidar deste computador")}
            description={t("Verificações, armazenamento e funcionamento em segundo plano.")}
            defaultOpen={
              initialSection === "general" ||
              Boolean(
                focusSetting && ["vmMemory", "resumeInterruptedTurns", "tray", "launchAtLogin"].includes(focusSetting),
              ) ||
              Boolean(error && (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384))
            }
          >
            {(open) => (
              <>
                {open && (
                  <DoctorChecks
                    api={api}
                    doctor={doctor ?? null}
                    error={doctorError ?? null}
                    onRefresh={onRefreshDoctor ?? (async () => undefined)}
                  />
                )}
                <SettingsGroup>
                  <Disclosure
                    className="settings-technical-details"
                    openWhen={
                      focusSetting === "vmMemory" ||
                      Boolean(error && (!Number.isInteger(vmMemory) || vmMemory < 512 || vmMemory > 16384))
                    }
                    summary={t("Detalhes técnicos")}
                  >
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
                  </Disclosure>
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
                  <SettingsRow
                    title={SETTINGS.launchAtLogin.label}
                    description={SETTINGS.launchAtLogin.description}
                    htmlFor={SETTINGS.launchAtLogin.controlId}
                    settingId={SETTINGS.launchAtLogin.id}
                  >
                    <SettingsSwitch
                      id={SETTINGS.launchAtLogin.controlId}
                      checked={launchAtLogin}
                      onChange={(event) => setLaunchAtLogin(event.target.checked)}
                    />
                  </SettingsRow>
                </SettingsGroup>
                {onImport && (
                  <button className="button button-quiet" type="button" onClick={onImport}>
                    {t("Import legacy app bots")}
                  </button>
                )}
              </>
            )}
          </SettingsDisclosure>
          <SettingsDisclosure
            title={t("Reportar problema")}
            description={t("Prepare um relatório, revise o conteúdo e escolha como compartilhar.")}
            defaultOpen={initialSection === "report"}
            onOpenChange={setReportOpen}
          >
            {(open) => open && <ReportProblem api={api} invokeCommand={invokeCommand} errorCode={reportErrorCode} />}
          </SettingsDisclosure>
        </SettingsPane>
        {isNativeDesktop() && (
          <SettingsPane {...pane("advanced")}>
            <Suspense fallback={<SettingsPaneLoading />}>
              <ServerModeSettings invokeCommand={invokeCommand} connectionErrorCode={serverConnectionErrorCode} />
            </Suspense>
          </SettingsPane>
        )}
      </SettingsLayout>
      {error && (
        <p className="settings-save-error warning-callout" role="alert">
          {error}
        </p>
      )}
      {section !== "advanced" && !(section === "diagnostics" && reportOpen) && (
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

const SettingsPaneLoading = () => <p role="status">{t("Loading")}</p>
