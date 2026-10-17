import { listen } from "@tauri-apps/api/event"
import type { BotGroup, Id, NotificationRecord } from "@touri/contracts"
import type { FailureAction } from "@touri/contracts/run-failure"
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  createApiClient,
  createTauriInvoke,
  resolveSidecarEndpoint,
  type TauriInvoke,
  type UiApi,
  webEndpoint,
} from "./api/client"
import type { ApprovalTarget } from "./approvalNavigation"
import { ApprovalNotice } from "./components/ApprovalNotice"
import { AvatarRuntimeProvider } from "./components/AvatarRuntime"
import { BotAvatar } from "./components/BotAvatar"
import { BotComputer } from "./components/BotComputer"
import { BotPanel } from "./components/BotPanel"
import { ChatPanel } from "./components/ChatPanel"
import CronScreen from "./components/CronScreen"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { ErrorNotice } from "./components/ErrorNotice"
import { EvidenceContext } from "./components/EvidenceGallery"
import { FailureActionContext } from "./components/FailureActionContext"
import { GroupModal, GroupPanel } from "./components/Groups"
import {
  BotCreateModal,
  BotModelModal,
  BotSettingsModal,
  DoctorModal,
  ImportWizard,
  ProjectModal,
  SettingsModal,
} from "./components/Modals"
import { MotionPresence, MotionSkeleton } from "./components/Motion"
import { PageTransition } from "./components/PageTransition"
import { RoutineEditor } from "./components/RoutineEditor"
import { SidebarDrawer } from "./components/SidebarDrawer"
import { IntegrationsScreen, McpScreen, PreviewScreen } from "./components/WorkspaceScreens"
import { installComputerKillSwitch } from "./computerKillSwitch"
import { openComputerWindow } from "./computerWindow"
import { type DeepLink, parseDeepLink } from "./deepLink"
import { navigatePage } from "./design/navigation"
import { errorRecovery, type RecoveryAction } from "./errorRecovery"
import { ApiError, userFacingError } from "./errors"
import { CommandPalette } from "./features/commandPalette/CommandPalette"
import type { PaletteActionId, PaletteCommand } from "./features/commandPalette/paletteItems"
import {
  type BotSettingsSectionId,
  destinationForSetting,
  type PaletteDestination,
  SETTINGS,
  settingsIndex,
} from "./features/commandPalette/settingsRegistry"
import { isNewBotShortcut, isPaletteShortcut } from "./features/commandPalette/shortcut"
import { HistoryMigrationStatus } from "./features/history/HistoryMigrationStatus"
import { ReportErrorButton } from "./features/reports/ReportErrorButton"
import { ReportMenuLauncher } from "./features/reports/ReportMenuLauncher"
import { localizeNotice, t } from "./i18n"
import { requestTaskResume, requestTaskReview } from "./recoveryEvents"
import type { RoutineDraft } from "./routineDraft"
import { isFailureNotice } from "./sidebarAttention"
import { useHost } from "./useHost"
import { useWorkspace } from "./useWorkspace"
import { type AppRoute, readWorkspaceState, saveWorkspaceState } from "./workspaceState"

export type UiKernel = { services?: { api?: UiApi | null; invoke?: TauriInvoke | null } }

type AppProps = { kernel?: UiKernel }
type ModalKind =
  | "group"
  | "doctor"
  | "import"
  | "bot"
  | "project"
  | "settings"
  | "bot-settings"
  | "bot-model"
  | "bot-permissions"
  | "bot-mcp"
  | null

const isTauriRuntime = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export const canUseMockAdapter = ({ dev, flag }: { dev: boolean; flag: string | undefined }): boolean =>
  dev && flag === "true"

const mockEnabled = canUseMockAdapter({
  dev: import.meta.env.DEV || import.meta.env.MODE === "e2e",
  flag: import.meta.env.VITE_ENABLE_MOCK,
})

type ConnectionState = "loading" | "ready" | "error"

const errorMessage = userFacingError

const AppContent = ({ kernel }: AppProps) => {
  const [api, setApi] = useState<UiApi | null>(() => kernel?.services?.api ?? null)
  const host = useHost(api)
  const attachmentButtonRef = useRef<HTMLButtonElement>(null)
  const apiRef = useRef(api)
  apiRef.current = api
  const [invokeCommand] = useState<TauriInvoke>(() => kernel?.services?.invoke ?? createTauriInvoke())
  const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
    kernel?.services?.api ? "ready" : "loading",
  )
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [retryingConnection, setRetryingConnection] = useState(false)
  const [panelsByBot, setPanelsByBot] = useState<Record<string, boolean>>(() => readWorkspaceState().panelsByBot ?? {})
  const [expandedBot, setExpandedBot] = useState<string | null>(null)
  const [libraryRequest, setLibraryRequest] = useState<{ botId: string; path: string; request: number } | null>(null)
  const [computerTabRequest, setComputerTabRequest] = useState<{ botId: string; request: number } | null>(null)
  const requestedComputer = new URLSearchParams(window.location.search).get("computer")
  const [editingGroup, setEditingGroup] = useState<BotGroup | null>(null)
  const [settingsInitialSection, setSettingsInitialSection] = useState("appearance")
  const [settingFocus, setSettingFocus] = useState<string | null>(null)
  const [botSettingsSection, setBotSettingsSection] = useState<BotSettingsSectionId | undefined>(undefined)
  const [projectLinkBotId, setProjectLinkBotId] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalKind>(null)
  useEffect(() => {
    const openReport = () => {
      setSettingsInitialSection("report")
      setModal("settings")
    }
    window.addEventListener("touri-report-problem", openReport)
    return () => {
      window.removeEventListener("touri-report-problem", openReport)
    }
  }, [])
  const [route, updateRoute] = useState<AppRoute>(
    () => readWorkspaceState().route ?? { section: "bots", screen: "chat" },
  )
  const setRoute = useCallback(
    (next: SetStateAction<AppRoute>): void => {
      navigatePage(route, typeof next === "function" ? next(route) : next, updateRoute)
    },
    [route],
  )
  useEffect(() => saveWorkspaceState({ route }), [route])
  const [routineDraft, setRoutineDraft] = useState<RoutineDraft | null>(null)
  const [localNotice, setLocalNotice] = useState<unknown>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const unavailableApi = useMemo<UiApi>(
    () => ({
      request: async () => {
        throw new Error(t("sidecar is not connected"))
      },
      subscribe: () => () => undefined,
      isMock: false,
    }),
    [],
  )
  const activeApi = api ?? unavailableApi
  useEffect(() => installComputerKillSwitch(activeApi, invokeCommand, setLocalNotice), [activeApi, invokeCommand])
  const workspace = useWorkspace(activeApi, api !== null)
  const { data, actions } = workspace
  const section = route.section
  const advancedPage = route.section === "advanced" ? route.page : null
  const screen = route.section === "bots" ? route.screen : "chat"
  const setScreen = (next: "chat" | "preview"): void => {
    setRoute((current) => (current.section === "bots" ? { ...current, screen: next } : current))
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry state is an explicit effect trigger
  useEffect(() => {
    if (kernel?.services?.api) {
      setApi(kernel.services.api)
      setConnectionState("ready")
      setConnectionError(null)
      return
    }
    let active = true
    let generation = 0
    const unlisten: Array<() => void> = []
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (reason: string): void => {
      setConnectionState("error")
      setConnectionError(reason)
      setRetryingConnection(false)
    }
    const connect = async (): Promise<void> => {
      const attempt = ++generation
      try {
        if (!isTauriRuntime() && mockEnabled) {
          const { createMockApi } = await import("./api/mock")
          if (!active || attempt !== generation) return
          const scenario = new URLSearchParams(window.location.search).get("mockScenario")
          setApi(createMockApi({ scenario: scenario === "resumed-turn" ? scenario : null }))
          setConnectionState("ready")
          return
        }
        const endpoint = isTauriRuntime() ? await resolveSidecarEndpoint(invokeCommand) : webEndpoint(window.location)
        const existing = apiRef.current
        existing?.updateEndpoint?.(endpoint)
        const resolved = existing?.updateEndpoint
          ? existing
          : createApiClient({
              endpoint,
              ...(isTauriRuntime() ? { resolveEndpoint: () => resolveSidecarEndpoint(invokeCommand) } : {}),
            })
        await resolved.request("GET /health", {})
        if (!active || attempt !== generation) return
        setApi(resolved)
        setConnectionState("ready")
        setConnectionError(null)
        setRetryingConnection(false)
      } catch (error) {
        if (!active || attempt !== generation) return
        if (!isTauriRuntime() && error instanceof ApiError && error.status === 401) {
          window.location.reload()
          return
        }
        fail(errorMessage(error))
        if (!isTauriRuntime()) {
          retryTimer = setTimeout(() => {
            if (active) void connect()
          }, 2000)
        }
      }
    }
    const start = async (): Promise<void> => {
      try {
        if (isTauriRuntime()) {
          const ready = await listen("sidecar-ready", () => {
            if (active) void connect()
          })
          if (!active) {
            ready()
            return
          }
          unlisten.push(ready)
          const failed = await listen<string>("sidecar-failed", (event) => {
            if (!active) return
            generation += 1
            setApi((current) => (current?.sendMessage ? current : null))
            fail(event.payload)
          })
          if (!active) {
            failed()
            return
          }
          unlisten.push(failed)
        }
        // Read the shell's endpoint/last_error after registering events: startup
        // failures can happen before the webview is able to listen.
        if (active) await connect()
      } catch (error) {
        if (active) fail(errorMessage(error))
      }
    }
    void start()
    return () => {
      active = false
      clearTimeout(retryTimer)
      unlisten.forEach((stop) => {
        stop()
      })
    }
  }, [invokeCommand, kernel?.services?.api, connectionAttempt])

  useEffect(() => {
    if (!api || api.isMock) return
    let active = true
    let disconnected = false
    const unsubscribe = api.subscribeConnection?.((connected) => {
      disconnected = !connected
      if (connected) {
        setConnectionState("ready")
        setConnectionError(null)
        setRetryingConnection(false)
        return
      }
      setConnectionState("error")
      setConnectionError(t("The sidecar connection is not available."))
      if (isTauriRuntime()) {
        void resolveSidecarEndpoint(invokeCommand).catch((error: unknown) => {
          if (active && disconnected) setConnectionError(errorMessage(error))
        })
      }
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [api, invokeCommand])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!isPaletteShortcut(event) || event.repeat) return
      event.preventDefault()
      // Dialogs (including approval confirmations) own the keyboard; the palette never opens over them.
      if (document.querySelector(".modal-card, [role='alertdialog']")) return
      setSearchOpen((current) => !current)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!isNewBotShortcut(event) || event.repeat) return
      event.preventDefault()
      if (document.querySelector(".modal-card, [role='alertdialog']")) return
      setModal("bot")
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  const [pendingLink, setPendingLink] = useState<DeepLink | null>(() => parseDeepLink(window.location.search))
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    void listen<DeepLink>("deep-link", (event) => setPendingLink(event.payload)).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  useEffect(() => {
    if (!pendingLink || data.bots.length === 0) return
    actions.selectLocation(pendingLink)
    setRoute({ section: "bots", screen: "chat" })
    setPendingLink(null)
    if (!isTauriRuntime()) window.history.replaceState(null, "", window.location.pathname)
  }, [pendingLink, data.bots.length, actions, setRoute])

  const [approvalFocus, setApprovalFocus] = useState<(ApprovalTarget & { request: number }) | null>(null)
  const reviewApproval = (target: ApprovalTarget): void => {
    const owner = data.threads.find((thread) => thread.id === target.threadId)
    if (!owner) return
    actions.selectLocation({ bot: owner.botId, thread: owner.id })
    setApprovalFocus((current) => ({ ...target, request: (current?.request ?? 0) + 1 }))
    setRoute({ section: "bots", screen: "chat" })
  }
  const notificationActions = {
    recover: async (item: NotificationRecord, action: RecoveryAction): Promise<void> => {
      actions.selectLocation({ bot: item.botId, thread: item.threadId })
      setRoute({ section: "bots", screen: "chat" })
      if (action === "login") runFailureAction({ kind: "setting", settingId: "providerLogin", label: "" })
      else if (action === "storage" || action === "doctor") openModal("doctor")
      else {
        const run = data.runs
          .filter(
            (run) =>
              run.threadId === item.threadId &&
              (run.status === "failed" || run.status === "interrupted") &&
              (run.finishedAt ?? 0) <= item.createdAt + 1000,
          )
          .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
        if (run && action === "retry") await actions.retryRun(run.id)
        else {
          if (run) requestTaskReview(run.id)
          if (action === "resume" && item.threadId) requestTaskResume(item.threadId)
        }
      }
    },
    open: (item: NotificationRecord): void => {
      // r8-sidebar: opening a failure acknowledges it using the existing persisted dismissal.
      if (isFailureNotice(item) && item.resolvedAt === null)
        void actions.dismissNotification(item.id).catch(setLocalNotice)
      // end r8-sidebar
      if (item.kind === "approval" && item.threadId && item.requestId) {
        reviewApproval({ threadId: item.threadId, approvalId: item.requestId })
        return
      }
      actions.selectLocation({ bot: item.botId, thread: item.threadId })
      setRoute({ section: "bots", screen: "chat" })
    },
    dismiss: actions.dismissNotification,
    dismissAll: actions.dismissAllNotifications,
    respond: actions.respondNotification,
    reply: actions.replyToNotification,
  }

  const selectedBot =
    data.bots.find((bot) => bot.id === (requestedComputer ?? data.selectedBotId)) ?? data.bots[0] ?? null
  const selectedThread = data.threads.find((thread) => thread.id === data.selectedThreadId) ?? null
  const selectedGroup = data.groups.find((g) => g.id === selectedThread?.groupId) ?? null
  const groupMembers =
    selectedGroup?.memberIds.flatMap((id) => {
      const b = data.bots.find((b) => b.id === id)
      return b ? [b] : []
    }) ?? []
  const selectedProject = data.projects.find((project) => project.id === selectedBot?.projectId) ?? null
  const selectedMessages = data.messages.filter((message) => message.threadId === selectedThread?.id)
  const selectedPreview =
    data.previews.find(
      (preview) =>
        preview.projectId === selectedProject?.id &&
        (preview.vmBotId ?? null) === (selectedBot?.machine === "vm" ? selectedBot.id : null),
    ) ?? null
  const botRoutines = data.routines.filter((routine) => routine.botId === selectedBot?.id)

  const panelOpen = selectedBot ? (panelsByBot[selectedBot.id] ?? false) : false
  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!selectedBot) return
      setPanelsByBot((current) => {
        const next = { ...current, [selectedBot.id]: open }
        saveWorkspaceState({ panelsByBot: next })
        return next
      })
      if (!open) setExpandedBot(null)
    },
    [selectedBot],
  )
  const evidenceContext = useMemo(
    () =>
      selectedBot && api
        ? {
            api,
            bot: selectedBot,
            onLibrary: (path: string, botId = selectedBot.id) => {
              if (botId !== selectedBot.id) actions.selectBot(botId)
              setPanelsByBot((current) => ({ ...current, [botId]: true }))
              setLibraryRequest((value) => ({ botId, path, request: (value?.request ?? 0) + 1 }))
            },
            onComputer: (botId = selectedBot.id) => {
              if (botId !== selectedBot.id) actions.selectBot(botId)
              setPanelsByBot((current) => ({ ...current, [botId]: true }))
              setComputerTabRequest((value) => ({ botId, request: (value?.request ?? 0) + 1 }))
            },
          }
        : null,
    [api, selectedBot, actions.selectBot],
  )

  const notice = localNotice ?? data.notice
  // This completion notice already points to the inline account recovery control.
  const noticeHasInlineRecovery = notice === t("Bot created. Could not connect your account. Sign in below to chat.")
  const noticeRecord = data.notifications.find(
    (item) => typeof notice === "string" && notice.endsWith(localizeNotice(item.body)),
  )
  const noticeRun = noticeRecord
    ? data.runs
        .filter(
          (run) =>
            run.threadId === noticeRecord.threadId &&
            (run.status === "failed" || run.status === "interrupted") &&
            (run.finishedAt ?? 0) <= noticeRecord.createdAt + 1000,
        )
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
    : undefined
  const noticeContext = {
    provider: noticeRun?.provider,
    errorClass: noticeRun?.errorClass,
    parts: data.activityMessages.find((message) => message.id === noticeRun?.replyMessageId)?.parts,
    savedMessage: !!noticeRun?.requestMessageId,
    occurredAt: noticeRun?.finishedAt ?? noticeRecord?.createdAt,
  }
  const showNotice = (message: string): void => {
    setLocalNotice(userFacingError(message))
    window.setTimeout(() => setLocalNotice(null), 4200)
  }
  const openModal = (kind: ModalKind): void => {
    if (kind !== "settings" && kind !== "doctor" && kind !== "bot-settings") setSettingFocus(null)
    if (kind === "bot-settings") setBotSettingsSection(undefined)
    if (kind === "project") setProjectLinkBotId(null)
    setModal(kind)
  }
  const closeModal = (): void => {
    setSettingFocus(null)
    setModal(null)
  }
  const runPaletteCommand = (command: PaletteCommand): void => {
    if (command.kind === "bot") {
      actions.selectBot(command.botId)
      setRoute({ section: "bots", screen: "chat" })
      return
    }
    if (command.kind === "thread") {
      actions.selectThread(command.threadId)
      setRoute({ section: "bots", screen: "chat" })
      return
    }
    if (command.kind === "action") {
      if (command.action === "new-group") setEditingGroup(null)
      if (command.action === "new-thread") {
        setRoute({ section: "bots", screen: "chat" })
        void actions.createThread()
        return
      }
      const kinds: Record<Exclude<PaletteActionId, "new-thread">, ModalKind> = {
        "new-bot": "bot",
        "new-group": "group",
        "connect-project": "project",
        "open-doctor": "doctor",
      }
      openModal(kinds[command.action])
      return
    }
    openDestination(command.destination)
  }
  const openDestination = (destination: PaletteDestination): void => {
    if (destination.kind === "page") {
      setRoute({ section: "advanced", page: destination.page })
      return
    }
    setSettingFocus(destination.settingId ?? null)
    if (destination.kind === "app-settings") {
      setSettingsInitialSection(destination.section)
      setModal("settings")
      return
    }
    if (destination.kind === "bot-settings") {
      setBotSettingsSection(destination.section)
      setModal("bot-settings")
      return
    }
    setModal("doctor")
  }
  const runFailureAction = (action: FailureAction): void => {
    if (action.kind === "doctor") openDestination({ kind: "doctor" })
    if (action.kind === "setting") openDestination(destinationForSetting(action.settingId))
  }
  const paletteSettings = useMemo(() => settingsIndex({ hasBot: data.bots.length > 0 }), [data.bots.length])
  const startProcess = async (processId: Id): Promise<void> => {
    await actions.startProcess(processId)
    setScreen("preview")
    showNotice(t("Process ready · preview opened"))
  }
  const retryConnection = async (): Promise<void> => {
    if (retryingConnection) return
    setConnectionState("error")
    setConnectionError((current) => current ?? data.notice ?? t("The sidecar connection is not available."))
    setRetryingConnection(true)
    try {
      if (isTauriRuntime()) await invokeCommand("sidecar_restart", {})
      setConnectionAttempt((attempt) => attempt + 1)
    } catch (error) {
      setConnectionState("error")
      setConnectionError(errorMessage(error))
      setRetryingConnection(false)
    }
  }

  if (connectionState === "error" && !(api?.sendMessage && data.bots.length > 0))
    return (
      <SidecarErrorScreen
        reason={connectionError ?? t("Unknown connection error")}
        onRetry={retryConnection}
        retrying={retryingConnection}
      />
    )
  if (!api && connectionState === "loading") return <LoadingScreen />
  if (!api)
    return <SidecarErrorScreen reason={t("The sidecar connection is not available.")} onRetry={retryConnection} />
  if (data.loading && data.bots.length === 0) return <LoadingScreen />
  if (!api.isMock && data.bots.length === 0 && data.notice)
    return <SidecarErrorScreen reason={data.notice} onRetry={retryConnection} />
  // Doctor and import are reachable from onboarding, before any bot exists, so they render outside the main layout too.
  const setupModal =
    modal === "doctor" ? (
      <DoctorModal
        api={api}
        doctor={data.doctor}
        doctorError={data.doctorError}
        onRefresh={actions.refreshDoctor}
        onClose={closeModal}
        onImport={() => setModal("import")}
        focusSetting={settingFocus}
        launchAtLogin={data.settings?.launchAtLogin ?? false}
        onLaunchAtLogin={(value) => actions.updateSettings({ launchAtLogin: value })}
      />
    ) : modal === "import" ? (
      <ImportWizard bots={data.bots} api={api} onClose={closeModal} onNotice={showNotice} />
    ) : null
  // Keep creation mounted when the first bot's live event replaces onboarding with the workspace.
  const botModal = (
    <MotionPresence show={modal === "bot"} kind="modal">
      <ErrorBoundary area="o diálogo" dialog api={api} onClose={closeModal}>
        {modal === "bot" && (
          <BotCreateModal
            api={api}
            invokeCommand={invokeCommand}
            cloudEnabled={data.settings?.cloud === true}
            capability={data.machineCapability}
            projects={data.projects}
            onCreateProject={actions.createProject}
            onClose={closeModal}
            onCreate={async (input, loginDraftId) => {
              const { loginReady } = await actions.createBot(input, loginDraftId)
              setRoute({ section: "bots", screen: "chat" })
              showNotice(
                loginReady
                  ? t("{name} created.", { name: input.name })
                  : t("Bot created. Could not connect your account. Sign in below to chat."),
              )
            }}
          />
        )}
      </ErrorBoundary>
    </MotionPresence>
  )
  if (data.bots.length === 0)
    return (
      <AvatarRuntimeProvider value={{ ...data, messages: data.activityMessages }}>
        {botModal}
        <OnboardingLanding
          host={host}
          onCreateBot={() => openModal("bot")}
          onDoctor={() => openModal("doctor")}
          onImport={() => openModal("import")}
        />
        <MotionPresence show={setupModal !== null} kind="modal">
          <ErrorBoundary key={modal} area="o diálogo" dialog api={api} onClose={closeModal}>
            {setupModal}
          </ErrorBoundary>
        </MotionPresence>
      </AvatarRuntimeProvider>
    )

  if (requestedComputer)
    return (
      <AvatarRuntimeProvider value={{ ...data, messages: data.activityMessages }}>
        <main className="computer-window">
          <header>
            <h1>Computador de {selectedBot?.name ?? "bot"}</h1>
          </header>
          {selectedBot?.id === requestedComputer ? (
            <ErrorBoundary key={selectedBot.id} area="o computador" api={api}>
              <BotComputer
                autoOpen
                key={selectedBot.id}
                api={api}
                bot={selectedBot}
                machine={data.machines.find((state) => state.botId === selectedBot.id)}
                activeTurns={data.runs.some(
                  (run) => run.botId === selectedBot.id && ["queued", "starting", "running"].includes(run.status),
                )}
              />
            </ErrorBoundary>
          ) : (
            <p role="alert">Bot não encontrado.</p>
          )}
        </main>
      </AvatarRuntimeProvider>
    )

  return (
    <AvatarRuntimeProvider value={{ ...data, messages: data.activityMessages }}>
      {botModal}
      <main className="app-shell">
        <HistoryMigrationStatus api={api} />
        {connectionState === "error" && (
          <div className="notice-bar" role="status">
            Sem conexão. Suas mensagens ficam na fila e serão enviadas ao reconectar.
          </div>
        )}
        {/* r8 motion: transient notice presence */}
        <MotionPresence show={Boolean(notice)} kind="toast">
          {Boolean(notice) && (
            <div className="notice-bar" role="status">
              <span>◈</span>
              {!noticeHasInlineRecovery &&
              (typeof notice !== "string" ||
                errorRecovery(notice).classified ||
                /erro|falh|failed|Error|[{}]/i.test(notice)) ? (
                <ErrorNotice
                  error={notice}
                  context={noticeContext}
                  onAction={async (action) => {
                    if (action === "retry") {
                      if (noticeRecord) {
                        await notificationActions.recover(noticeRecord, action)
                        return
                      }
                      // A provider notice must not restart the local service or replay a mutation.
                      await api.request("GET /health", {})
                      setLocalNotice(null)
                      actions.dismissNotice()
                    } else if (action === "login")
                      runFailureAction({ kind: "setting", settingId: "providerLogin", label: "" })
                    else if (action === "storage" || action === "doctor") openModal("doctor")
                    else if (noticeRecord) await notificationActions.recover(noticeRecord, action)
                    else {
                      // Without a task identity, refresh recorded state rather than guessing a target.
                      await api.request("GET /workspace/activity", {})
                      openModal("doctor")
                    }
                  }}
                />
              ) : typeof notice === "string" ? (
                notice
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setLocalNotice(null)
                  actions.dismissNotice()
                }}
                aria-label={t("Dismiss notice")}
              >
                ×
              </button>
            </div>
          )}
        </MotionPresence>
        {data.pendingRequestsOnReturn !== null && data.pendingRequestsOnReturn > 0 && (
          <div className="notice-bar approval-notice" role="status">
            {t("Você tem {n} solicitações pendentes.", { n: data.pendingRequestsOnReturn })}
            <button type="button" onClick={actions.dismissNotice} aria-label={t("Dismiss notice")}>
              ×
            </button>
          </div>
        )}
        <ApprovalNotice notifications={data.notifications} messages={data.activityMessages} onReview={reviewApproval} />
        <div className="app-grid">
          <SidebarDrawer
            groups={data.groups}
            onNewGroup={() => {
              setEditingGroup(null)
              openModal("group")
            }}
            onEditGroup={(g) => {
              setEditingGroup(g)
              openModal("group")
            }}
            onNewGroupThread={(g) => {
              void actions.createGroupThread(g.id).catch((e) => showNotice(userFacingError(e)))
              setRoute({ section: "bots", screen: "chat" })
            }}
            showFakeTrafficLights={api.isMock}
            bots={data.bots}
            onDeleteBot={actions.deleteBot}
            threads={data.threads}
            messages={data.activityMessages}
            runs={data.runs}
            floatUpdates={data.settings?.sidebarFloatUpdates ?? true}
            selectedBotId={selectedBot?.id ?? null}
            selectedThreadId={selectedThread?.id ?? null}
            section={section}
            advancedPage={advancedPage}
            onChat={() => setRoute({ section: "bots", screen: "chat" })}
            onAdvancedPage={(page) => setRoute({ section: "advanced", page })}
            onRoutines={(botId) => {
              if (botId !== data.selectedBotId) actions.selectBot(botId)
              setRoute({ section: "advanced", page: "cron", botId })
            }}
            onProject={() => openModal("project")}
            onImport={() => openModal("import")}
            onSelect={actions.selectBot}
            onSelectThread={actions.selectThread}
            onReviewApproval={reviewApproval}
            onNewThread={() => void actions.createThread()}
            onNewBot={() => openModal("bot")}
            onBotSettings={() => openModal("bot-settings")}
            onSettings={() => {
              setSettingsInitialSection("appearance")
              openModal("settings")
            }}
            onDoctor={() => openModal("doctor")}
            onSearch={() => setSearchOpen(true)}
            notifications={data.notifications}
            notificationActions={notificationActions}
            onNotificationsOpen={setNotificationsOpen}
          />
          <PageTransition route={route}>
            {screen === "preview" ? (
              <PreviewScreen
                project={selectedProject}
                processes={data.processes.filter((entry) => entry.spec.projectId === selectedProject?.id)}
                preview={selectedPreview}
                modalOpen={modal !== null || searchOpen || notificationsOpen}
                browserTabs={data.browserTabs}
                selectedBot={selectedBot}
                selectedThread={selectedThread}
                selectedMessages={selectedMessages}
                api={api}
                invokeCommand={invokeCommand}
                onStart={startProcess}
                onStop={actions.stopProcess}
                onRestart={actions.restartProcess}
                onSend={actions.sendMessage}
                onBack={() => setScreen("chat")}
                onReviewApprovals={reviewApproval}
                onConnectProject={() => openModal("project")}
                onNotice={showNotice}
              />
            ) : section === "advanced" && advancedPage === "cron" ? (
              <CronScreen
                host={data.routineHost}
                key={route.section === "advanced" ? (route.botId ?? "all") : "all"}
                initialBotFilter={route.section === "advanced" ? route.botId : undefined}
                loading={data.loading}
                loadError={data.bots.length === 0 ? data.notice : null}
                bots={data.bots}
                selectedBotId={data.selectedBotId}
                routines={data.routines}
                routineRuns={data.routineRuns}
                messages={data.activityMessages}
                actions={actions}
                onReviewApprovals={reviewApproval}
                onNotice={showNotice}
              />
            ) : section === "advanced" && advancedPage === "integracoes" ? (
              <IntegrationsScreen
                api={api}
                botId={selectedBot?.id ?? null}
                botName={selectedBot?.name ?? null}
                modalOpen={modal !== null}
                onConfigure={() => openModal("bot-mcp")}
              />
            ) : section === "advanced" && advancedPage === "mcp" ? (
              <McpScreen
                api={api}
                botId={selectedBot?.id ?? null}
                botName={selectedBot?.name ?? null}
                modalOpen={modal !== null}
                onConfigure={() => openModal("bot-mcp")}
              />
            ) : (
              <FailureActionContext.Provider value={runFailureAction}>
                <EvidenceContext.Provider value={evidenceContext}>
                  <div
                    className={`bot-workspace motion-workspace ${panelOpen ? "has-bot-panel" : ""} ${!selectedGroup && expandedBot === selectedBot?.id ? "computer-expanded" : ""}`}
                    data-motion-panel-open={panelOpen}
                  >
                    <ErrorBoundary key={selectedThread?.id ?? selectedBot?.id ?? "chat"} area="a conversa" api={api}>
                      <ChatPanel
                        onRepeatTask={setRoutineDraft}
                        group={selectedGroup}
                        groupMembers={groupMembers}
                        onEditGroup={() => {
                          setEditingGroup(selectedGroup)
                          openModal("group")
                        }}
                        focusApproval={
                          approvalFocus?.threadId === selectedThread?.id ? (approvalFocus ?? undefined) : undefined
                        }
                        panelOpen={panelOpen}
                        onTogglePanel={() => setPanelOpen(!panelOpen)}
                        machine={data.machines.find((state) => state.botId === selectedBot?.id)}
                        thread={selectedThread}
                        bot={selectedBot}
                        messages={selectedMessages}
                        runs={data.runs}
                        routines={data.routines}
                        routineRuns={data.routineRuns}
                        onSend={actions.sendMessage}
                        onRetry={actions.retryRun}
                        onCancel={actions.cancelRun}
                        onSwitchBranch={actions.switchBranch}
                        api={api}
                        computerGrant={
                          data.computerGrantRequest?.threadId === selectedThread?.id && selectedBot && selectedThread
                            ? { botId: selectedBot.id, threadId: selectedThread.id, botName: selectedBot.name }
                            : null
                        }
                        onComputerGrant={actions.dismissComputerGrant}
                        onOpenTools={() => setScreen("preview")}
                        onOpenComputer={() => {
                          setPanelOpen(true)
                          if (selectedBot)
                            setComputerTabRequest((value) => ({
                              botId: selectedBot.id,
                              request: (value?.request ?? 0) + 1,
                            }))
                        }}
                        attachmentButtonRef={attachmentButtonRef}
                        onOpenPermissions={() => openModal("bot-permissions")}
                        onOpenToolCatalog={() => openModal("bot-mcp")}
                        onOpenProviderLogin={() => {
                          setSettingFocus(SETTINGS.providerLogin.id)
                          setBotSettingsSection(SETTINGS.providerLogin.section)
                          setModal("bot-settings")
                        }}
                      />
                    </ErrorBoundary>
                    {/* r8 motion: preserve the panel during its inert exit */}
                    <MotionPresence show={panelOpen && Boolean(selectedGroup || selectedBot)} kind="panel">
                      {selectedGroup ? (
                        <GroupPanel
                          key={selectedGroup.id}
                          group={selectedGroup}
                          bots={groupMembers}
                          onEdit={() => {
                            setEditingGroup(selectedGroup)
                            openModal("group")
                          }}
                          onClose={() => {
                            setPanelOpen(false)
                            window.requestAnimationFrame(() =>
                              document.querySelector<HTMLButtonElement>(".bot-panel-toggle")?.focus(),
                            )
                          }}
                        />
                      ) : (
                        selectedBot && (
                          <ErrorBoundary key={selectedBot.id} area="o painel do bot" api={api}>
                            <BotPanel
                              libraryRequest={
                                libraryRequest?.botId === selectedBot.id ? (libraryRequest ?? undefined) : undefined
                              }
                              computerTabRequest={
                                computerTabRequest?.botId === selectedBot.id ? computerTabRequest.request : 0
                              }
                              key={selectedBot.id}
                              api={api}
                              groups={data.groups.filter((g) => g.memberIds.includes(selectedBot.id))}
                              onGroup={(g) => {
                                const thread = data.threads.find((t) => t.groupId === g.id && !t.groupThreadId)
                                if (thread) actions.selectThread(thread.id)
                              }}
                              bot={selectedBot}
                              machine={data.machines.find((state) => state.botId === selectedBot.id)}
                              routines={botRoutines}
                              activeTurns={data.runs.some(
                                (run) =>
                                  run.botId === selectedBot.id &&
                                  ["queued", "starting", "running"].includes(run.status),
                              )}
                              paused={modal !== null || searchOpen || notificationsOpen}
                              expanded={expandedBot === selectedBot.id}
                              onExpand={() => setExpandedBot((id) => (id === selectedBot.id ? null : selectedBot.id))}
                              onWindow={() => openComputerWindow(selectedBot.id)}
                              onClose={() => {
                                setPanelOpen(false)
                                window.requestAnimationFrame(() =>
                                  document.querySelector<HTMLButtonElement>(".bot-panel-toggle")?.focus(),
                                )
                              }}
                              onSettings={() => openModal("bot-settings")}
                              onModel={() => openModal("bot-model")}
                              onPermissions={() => openModal("bot-permissions")}
                              onPreview={() => setScreen("preview")}
                              active={data.runs.some(
                                (run) =>
                                  run.botId === selectedBot.id &&
                                  ["queued", "starting", "running"].includes(run.status),
                              )}
                              projects={data.projects}
                              onSelectProject={async (projectId) => {
                                if (selectedBot) await actions.updateBot(selectedBot.id, { projectId })
                              }}
                              onAddProject={() => {
                                openModal("project")
                                setProjectLinkBotId(selectedBot?.id ?? null)
                              }}
                              onRole={(roleLine) => actions.updateBot(selectedBot.id, { roleLine })}
                            />
                          </ErrorBoundary>
                        )
                      )}
                    </MotionPresence>
                  </div>
                </EvidenceContext.Provider>
              </FailureActionContext.Provider>
            )}
          </PageTransition>
        </div>
        {/* r8 motion: central overlay presence (settings content stays owned by its package) */}
        <ErrorBoundary area="a busca" dialog api={api} onClose={() => setSearchOpen(false)}>
          <CommandPalette
            api={api}
            open={searchOpen}
            bots={data.bots}
            threads={data.threads}
            messages={data.messages}
            settings={paletteSettings}
            hasBot={Boolean(selectedBot)}
            onClose={() => setSearchOpen(false)}
            onRun={runPaletteCommand}
          />
        </ErrorBoundary>
        <MotionPresence show={modal !== null && modal !== "bot"} kind="modal">
          <ErrorBoundary key={modal} area="o diálogo" dialog api={api} onClose={closeModal}>
            {modal === "group" && (
              <GroupModal
                group={editingGroup}
                bots={data.bots}
                onClose={closeModal}
                onSave={async (input) => {
                  await actions.createGroup(input, editingGroup?.id)
                  setRoute({ section: "bots", screen: "chat" })
                }}
              />
            )}
            {setupModal}
            {modal === "project" && (
              <ProjectModal
                project={null}
                selectedBotId={projectLinkBotId ?? data.selectedBotId}
                linkBotId={projectLinkBotId}
                bots={data.bots}
                api={api}
                invokeCommand={invokeCommand}
                actions={actions}
                onClose={closeModal}
                onOpenPreview={() => {
                  closeModal()
                  setRoute({ section: "bots", screen: "preview" })
                }}
                onNotice={showNotice}
              />
            )}
            {modal === "settings" && (
              <SettingsModal
                api={api}
                invokeCommand={invokeCommand}
                doctor={data.doctor}
                doctorError={data.doctorError}
                onRefreshDoctor={actions.refreshDoctor}
                onImport={() => setModal("import")}
                initialSection={settingsInitialSection}
                focusSetting={settingFocus}
                settings={data.settings}
                onClose={closeModal}
                onSave={actions.updateSettings}
              />
            )}
            {modal === "bot-model" && selectedBot && (
              <BotModelModal
                key={`${selectedBot.id}:${selectedBot.provider}`}
                api={api}
                bot={selectedBot}
                onSave={(model) => actions.updateBot(selectedBot.id, { model })}
                onClose={closeModal}
              />
            )}
            {(modal === "bot-settings" || modal === "bot-permissions" || modal === "bot-mcp") && selectedBot && (
              <BotSettingsModal
                invokeCommand={invokeCommand}
                bots={data.bots}
                permissionsOnly={modal === "bot-permissions"}
                focusMcp={modal === "bot-mcp"}
                onAttachFile={() => {
                  attachmentButtonRef.current?.click()
                  closeModal()
                }}
                initialSection={modal === "bot-settings" ? botSettingsSection : undefined}
                focusSetting={modal === "bot-settings" ? settingFocus : null}
                activeTurns={data.runs.some(
                  (run) => run.botId === selectedBot.id && ["queued", "starting", "running"].includes(run.status),
                )}
                onOpenRoutines={() => {
                  closeModal()
                  setRoute({ section: "advanced", page: "cron", botId: selectedBot.id })
                }}
                onOpenIntegrations={() => {
                  closeModal()
                  setRoute({ section: "advanced", page: "integracoes" })
                }}
                api={api}
                capability={data.machineCapability}
                machineState={data.machines.find((state) => state.botId === selectedBot.id)}
                bot={selectedBot}
                settings={data.settings}
                projects={data.projects}
                routines={botRoutines}
                actions={actions}
                onClose={closeModal}
              />
            )}
          </ErrorBoundary>
        </MotionPresence>
      </main>
      {routineDraft && (
        <RoutineEditor
          initial={routineDraft}
          bots={data.bots}
          host={data.routineHost}
          actions={actions}
          onClose={() => setRoutineDraft(null)}
        />
      )}
    </AvatarRuntimeProvider>
  )
}

const LoadingScreen = () => (
  <main className="loading-screen">
    <BotAvatar bot={{ id: "touri", color: "#e5322d" }} size={64} mood="connecting" />
    <p>{t("Warming the local workspace…")}</p>
    <MotionSkeleton />
  </main>
)

const SidecarErrorScreen = ({
  reason,
  onRetry,
  retrying = false,
}: {
  reason: string
  onRetry: () => void
  retrying?: boolean
}) => (
  <main className="error-screen">
    <div className="error-card" role="alert">
      <img className="error-bull" src="/touri-bull.png" alt="touri" />
      <p className="eyebrow">{t("local connection")}</p>
      <h1>{t("Couldn’t connect to touri services.")}</h1>
      <p>
        {reason.startsWith("schema mismatch:")
          ? t("The app and the local service use incompatible versions.")
          : t("Touri is unavailable until the local service reconnects.")}
      </p>
      <div className="error-reason">
        <ErrorNotice error={reason} showActions={false} />
      </div>
      <button type="button" className="button button-brand" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
        {t("Retry connection")}
        <span>→</span>
      </button>
      <ReportErrorButton message={reason} fallbackCode="TOURI-E1009" />
      <small>{t("The app will not replace your workspace with demo data.")}</small>
    </div>
  </main>
)

const OnboardingLanding = ({
  host,
  onCreateBot,
  onDoctor,
  onImport,
}: {
  host: "mac" | "server"
  onCreateBot: () => void
  onDoctor: () => void
  onImport: () => void
}) => (
  <main className="onboarding-screen">
    <div className="onboarding-card">
      <h1 className="brand-lockup">
        <img className="brand-bull" src="/touri-bull.png" alt="" />
        <span className="brand-name">touri</span>
      </h1>
      <p>{t("onboarding.privacy", { host: host === "mac" ? "Mac" : t("onboarding.server") })}</p>
      <div className="onboarding-actions">
        <button type="button" className="button button-brand" onClick={onCreateBot}>
          {t("Create my first bot")}
          <span aria-hidden="true">→</span>
        </button>
      </div>
      <div className="onboarding-secondary">
        <span>
          {t("Already use another tool?")}{" "}
          <button type="button" className="text-button" onClick={onImport}>
            {t("Import")}
          </button>
        </span>
        <button type="button" className="text-button" onClick={onDoctor}>
          {t(host === "mac" ? "Check this Mac" : "onboarding.checkServer")}
        </button>
      </div>
    </div>
  </main>
)

const App = (props: AppProps) => (
  <>
    <ErrorBoundary area="o app" app api={props.kernel?.services?.api ?? undefined}>
      <AppContent {...props} />
    </ErrorBoundary>
    <ReportMenuLauncher api={props.kernel?.services?.api ?? undefined} />
  </>
)

export default App
