import type {
  ApiRoutes,
  Bot,
  BotGroup,
  BrowserTabInfo,
  DoctorReport,
  GroupInput,
  Id,
  MachineCapability,
  MachineState,
  Message,
  NotificationRecord,
  PreviewTarget,
  ProcessRunState,
  ProcessSpec,
  Project,
  RespondBehavior,
  Routine,
  RoutineRun,
  Run,
  Thread,
  UiEvent,
  UiEventEnvelope,
} from "@touri/contracts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "./api/client"
import { reconcileApprovalMessages, reconcileApprovalNotifications } from "./approvalState"
import { userFacingError } from "./errors"
import { useDoctorReport } from "./features/doctor/useDoctorReport"
import { localizeNotice, t } from "./i18n"
import { useMachineParking } from "./machineIntents"
import { reconcileFailureNotifications } from "./sidebarAttention"
import { readWorkspaceState, saveWorkspaceState } from "./workspaceState"

type ProcessEntry = { spec: ProcessSpec; run: ProcessRunState | null }

export type WorkspaceData = {
  groups: Array<BotGroup>
  bots: Array<Bot>
  machineCapability: MachineCapability
  machines: Array<MachineState>
  threads: Array<Thread>
  messages: Array<Message>
  activityMessages: Array<Message>
  runs: Array<Run>
  projects: Array<Project>
  processes: Array<ProcessEntry>
  previews: Array<PreviewTarget>
  browserTabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>
  routines: Array<Routine>
  routineRuns: Array<RoutineRun>
  doctor: DoctorReport | null
  doctorError: string | null
  settings: ApiRoutes["GET /settings"]["res"]["settings"] | null
  selectedBotId: Id | null
  selectedThreadId: Id | null
  activeProjectId: Id | null
  loading: boolean
  notice: string | null
  importProgress: { phase: string; done: number; total: number } | null
  computerGrantRequest: { threadId: Id } | null
  notifications: Array<NotificationRecord>
}

export type WorkspaceActions = {
  refresh: () => Promise<void>
  refreshDoctor: () => Promise<void>
  selectBot: (botId: Id) => void
  selectThread: (threadId: Id) => void
  createGroup: (input: GroupInput, id?: string) => Promise<void>
  createGroupThread: (id: string) => Promise<void>
  createThread: () => Promise<void>
  sendMessage: (text: string, parentId?: Id | null, attachmentIds?: Array<Id>) => Promise<void>
  retryRun: (runId: Id) => Promise<void>
  cancelRun: (runId: Id) => Promise<void>
  switchBranch: (threadId: Id, leafId: Id) => Promise<void>
  updateBot: (botId: Id, patch: Partial<ApiRoutes["PATCH /bots/:id"]["req"]>) => Promise<void>
  deleteBot: (botId: Id, name: string, deleteVolumes: boolean) => Promise<void>
  machineAction: (botId: Id, reset: boolean, projectId?: Id | null, stopTurns?: boolean) => Promise<void>
  createBot: (input: ApiRoutes["POST /bots"]["req"], loginDraftId?: string) => Promise<void>
  toggleRoutine: (routine: Routine) => Promise<void>
  runRoutine: (routineId: Id) => Promise<void>
  createRoutine: (input: ApiRoutes["POST /routines"]["req"]) => Promise<void>
  updateRoutine: (routineId: Id, patch: ApiRoutes["PATCH /routines/:id"]["req"]) => Promise<void>
  createProject: (input: ApiRoutes["POST /projects"]["req"]) => Promise<Project>
  createProcess: (
    projectId: Id,
    name: string,
    input: ApiRoutes["PUT /projects/:id/processes/:name"]["req"],
  ) => Promise<void>
  startProcess: (processId: Id) => Promise<void>
  stopProcess: (processId: Id) => Promise<void>
  restartProcess: (processId: Id) => Promise<void>
  refreshProject: () => Promise<void>
  updateSettings: (patch: Partial<ApiRoutes["PATCH /settings"]["req"]>) => Promise<void>
  selectLocation: (location: { bot: Id | null; thread: Id | null }) => void
  dismissNotification: (id: number) => Promise<void>
  dismissAllNotifications: () => Promise<void>
  respondNotification: (args: {
    notification: NotificationRecord
    behavior: RespondBehavior
    message?: string
  }) => Promise<void>
  replyToNotification: (args: { notification: NotificationRecord; text: string }) => Promise<void>
  dismissComputerGrant: () => void
  dismissNotice: () => void
}

export type Workspace = { data: WorkspaceData; actions: WorkspaceActions }

const emptyState = (): WorkspaceData => ({
  groups: [],
  bots: [],
  machineCapability: { available: false, reason: t("No virtualization on this host"), provider: null },
  machines: [],
  threads: [],
  messages: [],
  activityMessages: [],
  runs: [],
  projects: [],
  processes: [],
  previews: [],
  browserTabs: [],
  routines: [],
  routineRuns: [],
  doctor: null,
  doctorError: null,
  settings: null,
  selectedBotId: readWorkspaceState().botId ?? null,
  selectedThreadId: readWorkspaceState().threadId ?? null,
  activeProjectId: null,
  loading: true,
  notice: null,
  importProgress: null,
  computerGrantRequest: null,
  notifications: [],
})

const uniqueById = <T extends { id: Id }>(rows: Array<T>): Array<T> => {
  const result = new Map<Id, T>()
  rows.forEach((row) => {
    result.set(row.id, row)
  })
  return [...result.values()]
}

const mergeRunRows = <T extends { id: Id; status: string; finishedAt: number | null }>(
  current: T[],
  incoming: T[],
): T[] => {
  const rows = new Map(current.map((row) => [row.id, row]))
  for (const row of incoming) {
    const previous = rows.get(row.id)
    // A REST response may arrive after the terminal WebSocket event.
    if (
      previous?.finishedAt !== null &&
      previous?.finishedAt !== undefined &&
      (row.finishedAt === null || row.status !== previous.status)
    )
      continue
    rows.set(row.id, row)
  }
  return [...rows.values()]
}

const mergeThreads = (current: Thread[], incoming: Thread[]): Thread[] => {
  const rows = new Map(current.map((thread) => [thread.id, thread]))
  for (const thread of incoming) {
    const previous = rows.get(thread.id)
    if (
      previous &&
      ((previous.updatedSeq ?? 0) > (thread.updatedSeq ?? 0) ||
        ((previous.updatedSeq ?? 0) === (thread.updatedSeq ?? 0) && previous.updatedAt > thread.updatedAt))
    )
      continue
    rows.set(thread.id, thread)
  }
  return [...rows.values()]
}

export const updateMessage = (messages: Array<Message>, incoming: Message): Array<Message> => {
  const previous = messages.find((message) => message.id === incoming.id && message.threadId === incoming.threadId)
  if (previous?.updatedSeq !== undefined && (incoming.updatedSeq ?? 0) < previous.updatedSeq) return messages
  if (previous?.role === "assistant" && previous.runId && previous.status !== "streaming") {
    const prose = (parts: Message["parts"]) => parts.filter((part) => part.type === "text" || part.type === "reasoning")
    if (
      incoming.status !== previous.status ||
      incoming.runId !== previous.runId ||
      incoming.text !== previous.text ||
      JSON.stringify(prose(incoming.parts)) !== JSON.stringify(prose(previous.parts))
    )
      return messages
  }
  if (
    previous?.delivery &&
    incoming.delivery &&
    previous.updatedSeq === undefined &&
    incoming.updatedSeq === undefined
  ) {
    const order = { queued: 0, sent: 1, acked: 2, failed: 2 }
    if (order[previous.delivery.status] > order[incoming.delivery.status]) return messages
  }
  const next = structuredClone(incoming)
  next.parts = next.parts.map((part) => {
    if (part.type !== "approval" || part.decision !== "pending") return part
    return (
      previous?.parts.find(
        (old) => old.type === "approval" && old.approvalId === part.approvalId && old.decision !== "pending",
      ) ?? part
    )
  })
  return previous
    ? messages.map((message) => (message.id === next.id && message.threadId === next.threadId ? next : message))
    : [...messages, next]
}

export const applyDelta = (
  messages: Array<Message>,
  messageId: Id,
  delta: string,
  partIndex: number,
  offset?: number,
  revision?: Extract<UiEvent, { type: "message.delta" }>,
): Array<Message> =>
  messages.map((message) => {
    if (message.id !== messageId || message.status !== "streaming") return message
    if (revision?.threadId !== undefined && message.threadId !== revision.threadId) return message
    if (revision?.updatedSeq !== undefined && revision.updatedSeq <= (message.updatedSeq ?? 0)) return message
    if (revision?.generation !== undefined && revision.generation < (message.generation ?? 0)) return message
    const parts = [...message.parts]
    const current = parts[partIndex]
    const previous = current?.type === "text" || current?.type === "reasoning" ? current.text : ""
    if (offset !== undefined && offset > previous.length) return message
    // An offset makes snapshot/delta overlap and replay safe without deleting legitimate repeated words.
    const suffix = offset === undefined ? delta : delta.slice(Math.max(0, previous.length - offset))
    const reasoning = revision?.partType === "reasoning" || current?.type === "reasoning"
    if (reasoning) parts[partIndex] = { type: "reasoning", text: previous + suffix }
    else parts[partIndex] = { type: "text", text: previous + suffix }
    return {
      ...message,
      text: reasoning ? message.text : message.text + suffix,
      parts,
      updatedAt: revision?.updatedAt ?? Date.now(),
      ...(revision?.updatedSeq !== undefined ? { updatedSeq: revision.updatedSeq } : {}),
      ...(revision?.generation !== undefined ? { generation: revision.generation } : {}),
    }
  })

const MAX_NOTIFICATIONS = 200

const withoutBot = (data: WorkspaceData, botId: Id): WorkspaceData => {
  const threadIds = new Set(data.threads.filter((thread) => thread.botId === botId).map((thread) => thread.id))
  const routineIds = new Set(data.routines.filter((routine) => routine.botId === botId).map((routine) => routine.id))
  const bots = data.bots.filter((bot) => bot.id !== botId)
  const threads = data.threads.filter((thread) => !threadIds.has(thread.id))
  const selectedBotId = data.selectedBotId === botId ? (bots[0]?.id ?? null) : data.selectedBotId
  return {
    ...data,
    bots,
    threads,
    selectedBotId,
    selectedThreadId: threadIds.has(data.selectedThreadId ?? "")
      ? (threads.find((thread) => thread.botId === selectedBotId)?.id ?? null)
      : data.selectedThreadId,
    messages: data.messages.filter((message) => !threadIds.has(message.threadId)),
    activityMessages: data.activityMessages.filter((message) => !threadIds.has(message.threadId)),
    runs: data.runs.filter((run) => run.botId !== botId),
    routines: data.routines.filter((routine) => !routineIds.has(routine.id)),
    routineRuns: data.routineRuns.filter((run) => !routineIds.has(run.routineId)),
    machines: data.machines.filter((machine) => machine.botId !== botId),
    notifications: data.notifications.filter((item) => item.botId !== botId),
    previews: data.previews.filter((preview) => preview.vmBotId !== botId),
    groups: data.groups.map((group) => ({
      ...group,
      memberIds: group.memberIds.filter((id) => id !== botId),
      coordinatorBotId: group.coordinatorBotId === botId ? null : group.coordinatorBotId,
    })),
  }
}

const upsertNotification = (list: Array<NotificationRecord>, next: NotificationRecord): Array<NotificationRecord> => {
  const found = list.some((item) => item.id === next.id)
  const merged = found
    ? list.map((item) =>
        item.id === next.id ? (item.resolvedAt !== null && next.resolvedAt === null ? item : next) : item,
      )
    : [next, ...list]
  return merged.slice(0, MAX_NOTIFICATIONS)
}

const errorMessage = userFacingError

const lastActiveThread = (threads: Thread[], runs: Run[], botId: Id, rememberedId?: Id): Thread | undefined => {
  const candidates = threads.filter((thread) => thread.botId === botId && !thread.groupId)
  const activeRuns = runs
    .filter((run) => ["queued", "starting", "running"].includes(run.status))
    .sort((a, b) => (b.startedAt ?? b.queuedAt) - (a.startedAt ?? a.queuedAt))
  for (const run of activeRuns) {
    const thread = candidates.find((candidate) => candidate.id === run.threadId)
    if (thread) return thread
  }
  return (
    candidates.find((thread) => thread.id === rememberedId) ??
    candidates.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0]
  )
}

export const useWorkspace = (api: UiApi, enabled = true): Workspace => {
  const createdLoginDrafts = useRef(new Map<string, Bot>())
  const diagnosis = useDoctorReport(api, enabled)
  const [data, setData] = useState<WorkspaceData>(emptyState)
  const currentData = useRef(data)
  currentData.current = data
  useMachineParking(api, data.bots, enabled && !data.loading)
  const privateThreads = useRef(new Set<string>())
  const threadsByBot = useRef(readWorkspaceState().threadsByBot ?? {})
  const generation = useRef(0)
  const runRevision = useRef(0)
  const liveRuns = useRef(new Map<Id, number>())
  const loadedThreads = useRef(new Map<Id, number>())
  const threadLoads = useRef(
    new Map<
      Id,
      {
        attempt: number
        promise: Promise<void>
        deltas: Array<Extract<UiEvent, { type: "message.delta" }>>
      }
    >(),
  )
  const projectGeneration = useRef(0)
  const [projectRevision, setProjectRevision] = useState(0)
  useEffect(() => {
    if (!data.loading && data.selectedBotId) {
      if (data.selectedThreadId) threadsByBot.current[data.selectedBotId] = data.selectedThreadId
      saveWorkspaceState({
        botId: data.selectedBotId,
        threadId: data.selectedThreadId,
        threadsByBot: threadsByBot.current,
      })
    }
  }, [data.loading, data.selectedBotId, data.selectedThreadId])

  const loadProject = useCallback(
    async (projectId: Id | null, vmBotId?: Id): Promise<void> => {
      const projectAttempt = ++projectGeneration.current
      if (!projectId) {
        setData((current) => ({ ...current, processes: [], activeProjectId: null }))
        return
      }
      const attempt = generation.current
      try {
        const response = await api.request("GET /projects/:id/processes", vmBotId ? { vmBotId } : {}, { id: projectId })
        if (attempt !== generation.current || projectAttempt !== projectGeneration.current) return
        setData((current) =>
          current.activeProjectId === projectId ? { ...current, processes: response.processes } : current,
        )
      } catch {
        if (attempt !== generation.current || projectAttempt !== projectGeneration.current) return
        setData((current) =>
          current.activeProjectId === projectId
            ? { ...current, processes: [], notice: t("Project processes are unavailable.") }
            : current,
        )
      }
    },
    [api],
  )

  const loadThread = useCallback(
    (threadId: Id, force = false): Promise<void> => {
      const attempt = generation.current
      const pending = threadLoads.current.get(threadId)
      if (pending?.attempt === attempt) return pending.promise
      if (!force && loadedThreads.current.get(threadId) === attempt) return Promise.resolve()
      const deltas: Array<Extract<UiEvent, { type: "message.delta" }>> = []
      const promise = Promise.all([
        api.request("GET /threads/:id/messages", { all: true }, { id: threadId }),
        api.request("GET /threads/:id/runs", { all: true }, { id: threadId }),
      ])
        .then(([messages, runs]) => {
          if (attempt !== generation.current) return
          loadedThreads.current.set(threadId, attempt)
          setData((current) => ({
            ...current,
            messages: deltas.reduce(
              (rows, event) => applyDelta(rows, event.messageId, event.delta, event.partIndex, event.offset, event),
              messages.messages.reduce(updateMessage, current.messages),
            ),
            runs: mergeRunRows(current.runs, runs.runs),
          }))
        })
        .catch((error: unknown) => {
          if (attempt === generation.current)
            setData((current) => ({ ...current, notice: t("Service request failed", { error: errorMessage(error) }) }))
        })
        .finally(() => {
          if (threadLoads.current.get(threadId)?.promise === promise) threadLoads.current.delete(threadId)
        })
      threadLoads.current.set(threadId, { attempt, promise, deltas })
      return promise
    },
    [api],
  )

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return
    const attempt = ++generation.current
    const runsAtStart = runRevision.current
    try {
      const [
        groupResponse,
        botResponse,
        projectResponse,
        settingsResponse,
        previewResponse,
        browserResponse,
        routinesResponse,
        routineRunsResponse,
        notificationsResponse,
        machineResponse,
        activityResponse,
      ] = await Promise.all([
        api.request("GET /groups", {}).catch(() => ({ groups: [] })),
        api.request("GET /bots", {}),
        api.request("GET /projects", {}),
        api.request("GET /settings", {}),
        api.request("GET /previews", {}),
        api.request("GET /browser/tabs", {}).catch(() => ({ tabs: [] })),
        api.request("GET /routines", {}),
        api.request("GET /routine-runs", {}).catch(() => ({ routineRuns: [] })),
        api.request("GET /notifications", {}).catch(() => ({ notifications: [] })),
        api.request("GET /machines", {}).catch(() => ({
          capability: { available: false, reason: t("No virtualization on this host"), provider: null },
          machines: [],
        })),
        api.request("GET /workspace/activity", {}),
      ])
      const [botThreads, groupThreads] = await Promise.all([
        Promise.all(
          botResponse.bots.map(async (bot) => {
            const response = await api.request("GET /bots/:id/threads", {}, { id: bot.id })
            return response.threads
          }),
        ),
        Promise.all((groupResponse?.groups ?? []).map((g) => api.request("GET /groups/:id/threads", {}, { id: g.id }))),
      ])
      const allThreads = [...botThreads.flat(), ...groupThreads.flatMap((r) => r.threads)]
      if (attempt !== generation.current) return
      setData((current) => {
        const runIds = new Set(activityResponse.runs.map((run) => run.id))
        const runs = mergeRunRows(
          current.runs.filter(
            (run) =>
              !["queued", "starting", "running"].includes(run.status) ||
              runIds.has(run.id) ||
              (liveRuns.current.get(run.id) ?? 0) > runsAtStart,
          ),
          activityResponse.runs,
        )
        const selectedBot = botResponse.bots.find((bot) => bot.id === current.selectedBotId) ?? botResponse.bots[0]
        const selectedThread =
          allThreads.find((thread) => thread.id === current.selectedThreadId && thread.botId === selectedBot?.id) ??
          lastActiveThread(
            allThreads,
            runs,
            selectedBot?.id ?? "",
            current.selectedThreadId ?? threadsByBot.current[selectedBot?.id ?? ""],
          )
        return {
          ...current,
          groups: groupResponse?.groups ?? [],
          bots: uniqueById(botResponse.bots),
          machineCapability: machineResponse.capability,
          machines: machineResponse.machines,
          threads: mergeThreads(current.threads, allThreads),
          messages: (api.pendingMessages?.() ?? []).reduce(updateMessage, current.messages),
          activityMessages: activityResponse.messages,
          runs,
          projects: projectResponse.projects,
          previews: previewResponse.previews,
          browserTabs: browserResponse.tabs,
          routines: uniqueById(routinesResponse.routines),
          routineRuns: uniqueById(routineRunsResponse.routineRuns),
          settings: settingsResponse.settings,
          notifications: notificationsResponse.notifications,
          selectedBotId: selectedBot?.id ?? null,
          selectedThreadId: selectedThread?.id ?? null,
          activeProjectId: selectedBot?.projectId ?? null,
          loading: false,
          notice: null,
        }
      })
      setProjectRevision((value) => value + 1)
      const selected = currentData.current
      const threadId = selected.selectedThreadId
      if (
        !selected.loading &&
        threadId &&
        botResponse.bots.some((bot) => bot.id === selected.selectedBotId) &&
        allThreads.some((thread) => thread.id === threadId && thread.botId === selected.selectedBotId)
      )
        await loadThread(threadId)
    } catch (error) {
      if (attempt !== generation.current) return
      setData((current) => ({
        ...current,
        loading: false,
        notice: api.isMock
          ? "Demo data · sidecar services are optional"
          : t("Service request failed", { error: errorMessage(error) }),
      }))
    }
  }, [api, enabled, loadThread])

  useEffect(() => {
    if (!enabled) return
    let active = true
    let resyncing: Promise<void> | null = null
    const resync = (): void => {
      if (resyncing) return
      resyncing = load().finally(() => {
        resyncing = null
      })
    }
    // A reconnect needs no reload: the sidecar replays the gap, or sends a resync frame when the gap is
    // too large or expired. Reloading every conversation on each reconnect kept a slow client behind.
    const unsubscribe = api.subscribe((envelope: UiEventEnvelope) => {
      const event = envelope.event
      if (event.type === "thread.updated" && event.thread.groupThreadId) {
        privateThreads.current.add(event.thread.id)
        return
      }
      if (
        (event.type === "message.created" || event.type === "message.updated") &&
        privateThreads.current.has(event.message.threadId)
      )
        return
      if (event.type === "message.delta" && privateThreads.current.has(event.threadId)) return
      if (event.type === "transcript.resync") {
        resync()
        return
      }
      if (event.type === "message.delta") threadLoads.current.get(event.threadId)?.deltas.push(event)
      if (event.type === "run.updated") liveRuns.current.set(event.run.id, ++runRevision.current)
      setData((current) => {
        if (event.type === "machine.updated")
          return {
            ...current,
            previews:
              event.machine.status === "running"
                ? current.previews
                : current.previews.filter((preview) => preview.vmBotId !== event.machine.botId),
            machines: [...current.machines.filter((state) => state.botId !== event.machine.botId), event.machine],
          }
        if (event.type === "group.updated") return { ...current, groups: uniqueById([...current.groups, event.group]) }
        if (event.type === "thread.updated" && event.thread.groupThreadId) return current
        if (event.type === "bot.updated") return { ...current, bots: uniqueById([...current.bots, event.bot]) }
        if (event.type === "bot.deleted") return withoutBot(current, event.botId)
        if (event.type === "project.created")
          return { ...current, projects: uniqueById([...current.projects, event.project]) }
        if (event.type === "browser.tab")
          return {
            ...current,
            browserTabs: [
              ...current.browserTabs.filter((tab) => tab.tabId !== event.tab.tabId),
              ...(event.tab.state === "closed" ? [] : [event.tab]),
            ],
          }
        if (event.type === "thread.updated")
          return {
            ...current,
            selectedBotId: current.selectedThreadId === event.thread.id ? event.thread.botId : current.selectedBotId,
            threads: mergeThreads(current.threads, [event.thread]),
          }
        if (event.type === "message.created" || event.type === "message.updated")
          return {
            ...current,
            messages: updateMessage(current.messages, event.message),
            threads:
              event.message.delivery && event.message.delivery.status !== "acked" && event.type === "message.created"
                ? current.threads.map((thread) =>
                    thread.id === event.message.threadId ? { ...thread, activeLeafId: event.message.id } : thread,
                  )
                : current.threads,
          }
        if (event.type === "message.delta") {
          const message = current.messages.find((row) => row.id === event.messageId && row.threadId === event.threadId)
          const part = message?.parts[event.partIndex]
          const length = part?.type === "text" || part?.type === "reasoning" ? part.text.length : 0
          if (!message || (event.offset !== undefined && event.offset > length)) {
            // Unopened threads have no snapshot to repair; selection fetches their current history.
            if (event.threadId === current.selectedThreadId && !threadLoads.current.has(event.threadId))
              queueMicrotask(() => {
                void loadThread(event.threadId, true)
                threadLoads.current.get(event.threadId)?.deltas.push(event)
              })
          }
          return {
            ...current,
            messages: applyDelta(current.messages, event.messageId, event.delta, event.partIndex, event.offset, event),
          }
        }
        if (event.type === "run.updated") return { ...current, runs: mergeRunRows(current.runs, [event.run]) }
        if (event.type === "routine.updated")
          return {
            ...current,
            routines: uniqueById([
              ...current.routines.filter((routine) => routine.id !== event.routine.id),
              event.routine,
            ]),
            routineRuns: event.lastRun ? mergeRunRows(current.routineRuns, [event.lastRun]) : current.routineRuns,
          }
        if (event.type === "process.updated")
          return {
            ...current,
            previews:
              event.run && ["starting", "running", "ready"].includes(event.run.status)
                ? current.previews
                : current.previews.filter((preview) => preview.processId !== event.spec.id),
            processes: current.processes.map((entry) =>
              entry.spec.id === event.spec.id ? { spec: event.spec, run: event.run } : entry,
            ),
          }
        if (event.type === "preview.available")
          return {
            ...current,
            previews: [...current.previews.filter((preview) => preview.url !== event.preview.url), event.preview],
          }
        if (event.type === "import.progress")
          return { ...current, importProgress: { phase: event.phase, done: event.done, total: event.total } }
        if (event.type === "notification.created" || event.type === "notification.resolved")
          return { ...current, notifications: upsertNotification(current.notifications, event.notification) }
        if (event.type === "notify")
          return {
            ...current,
            notice: `${localizeNotice(event.title)}: ${localizeNotice(event.body)}`,
            computerGrantRequest:
              event.title === "Computer use approval" && event.threadId
                ? { threadId: event.threadId }
                : current.computerGrantRequest,
          }
        return current
      })
    })
    // Subscribe first, then load: the snapshot starts where live delivery does.
    void (api.cursorReady?.() ?? Promise.resolve()).then(() => {
      if (active) void load()
    })
    return () => {
      active = false
      generation.current += 1
      unsubscribe()
    }
  }, [api, enabled, load, loadThread])

  const selectedBot = useMemo(
    () => data.bots.find((bot) => bot.id === data.selectedBotId) ?? null,
    [data.bots, data.selectedBotId],
  )
  const selectedThread = useMemo(
    () => data.threads.find((thread) => thread.id === data.selectedThreadId) ?? null,
    [data.threads, data.selectedThreadId],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and reconnect also refresh the selected transcript
  useEffect(() => {
    if (enabled && !data.loading && data.selectedThreadId) void loadThread(data.selectedThreadId)
  }, [enabled, data.loading, data.selectedThreadId, projectRevision, loadThread])

  // A bot update may precede its project event (or come from an older sidecar).
  const missingProjectIds = [...new Set(data.bots.map((bot) => bot.projectId))]
    .filter((id) => id && !data.projects.some((project) => project.id === id))
    .sort()
    .join(",")
  useEffect(() => {
    if (!enabled || !missingProjectIds) return
    let active = true
    void api.request("GET /projects", {}).then(
      ({ projects }) => {
        if (active) setData((current) => ({ ...current, projects: uniqueById([...projects, ...current.projects]) }))
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [api, enabled, missingProjectIds])

  // biome-ignore lint/correctness/useExhaustiveDependencies: each REST reload must refresh processes, even when project ID is unchanged
  useEffect(() => {
    if (enabled) void loadProject(data.activeProjectId, selectedBot?.machine === "vm" ? selectedBot.id : undefined)
  }, [enabled, data.activeProjectId, selectedBot?.id, selectedBot?.machine, loadProject, projectRevision])

  // Bot assignments can arrive from a project dialog or an event while preview is open.
  useEffect(() => {
    setData((current) => {
      const projectId = selectedBot?.projectId ?? null
      return current.activeProjectId === projectId ? current : { ...current, activeProjectId: projectId, processes: [] }
    })
  }, [selectedBot?.projectId])

  const selectBot = useCallback((botId: Id): void => {
    setData((current) => {
      if (current.selectedBotId && current.selectedThreadId)
        threadsByBot.current[current.selectedBotId] = current.selectedThreadId
      const thread = lastActiveThread(current.threads, current.runs, botId, threadsByBot.current[botId])
      const bot = current.bots.find((candidate) => candidate.id === botId)
      return {
        ...current,
        selectedBotId: botId,
        selectedThreadId: thread?.id ?? null,
        activeProjectId: bot?.projectId ?? null,
        processes: [],
      }
    })
  }, [])

  const selectThread = useCallback((threadId: Id): void => {
    setData((current) => ({
      ...current,
      selectedBotId: current.threads.find((thread) => thread.id === threadId)?.botId ?? current.selectedBotId,
      selectedThreadId: threadId,
      threads: current.threads.map((thread) => (thread.id === threadId ? { ...thread, unread: 0 } : thread)),
    }))
  }, [])

  const createGroup = useCallback(
    async (input: GroupInput, id?: string) => {
      if (id) {
        const response = await api.request("PATCH /groups/:id", input, { id })
        setData((current) => ({ ...current, groups: uniqueById([...current.groups, response.group]) }))
      } else {
        const response = await api.request("POST /groups", input)
        setData((current) => ({
          ...current,
          groups: uniqueById([...current.groups, response.group]),
          threads: uniqueById([...current.threads, response.thread]),
          selectedThreadId: response.thread.id,
          selectedBotId: response.thread.botId,
        }))
      }
    },
    [api],
  )
  const createGroupThread = useCallback(
    async (id: string) => {
      const response = await api.request("POST /groups/:id/threads", { title: "Nova conversa" }, { id })
      setData((current) => ({
        ...current,
        threads: uniqueById([...current.threads, response.thread]),
        selectedThreadId: response.thread.id,
        selectedBotId: response.thread.botId,
      }))
    },
    [api],
  )
  const createThread = useCallback(async (): Promise<void> => {
    if (selectedThread?.groupId) {
      await createGroupThread(selectedThread.groupId)
      return
    }
    if (!selectedBot) return
    const response = await api.request("POST /threads", { botId: selectedBot.id, title: t("New conversation") })
    setData((current) => ({
      ...current,
      threads: uniqueById([...current.threads, response.thread]),
      selectedThreadId: response.thread.id,
    }))
  }, [api, selectedBot, selectedThread, createGroupThread])

  const sendMessage = useCallback(
    async (text: string, parentId?: Id | null, attachmentIds: Array<Id> = []): Promise<void> => {
      if (!selectedThread || !text.trim()) return
      const input = {
        threadId: selectedThread.id,
        parentId: parentId === undefined ? selectedThread.activeLeafId : parentId,
        text: text.trim(),
        attachmentIds,
      }
      const response = api.sendMessage
        ? await api.sendMessage(input)
        : await api.request("POST /threads/:id/messages", input, { id: selectedThread.id })
      setData((current) => ({
        ...current,
        messages: updateMessage(current.messages, response.message),
        threads: current.threads.map((thread) =>
          thread.id === selectedThread.id ? { ...thread, activeLeafId: response.message.id } : thread,
        ),
        runs: response.run ? mergeRunRows(current.runs, [response.run]) : current.runs,
      }))
    },
    [api, selectedThread],
  )

  const retryRun = useCallback(
    async (runId: Id): Promise<void> => {
      const response = await api.request("POST /runs/:id/retry", {}, { id: runId })
      setData((current) => ({ ...current, runs: mergeRunRows(current.runs, [response.run]) }))
    },
    [api],
  )

  const cancelRun = useCallback(
    async (runId: Id): Promise<void> => {
      const response = await api.request("POST /runs/:id/cancel", {}, { id: runId })
      setData((current) => ({ ...current, runs: mergeRunRows(current.runs, [response.run]) }))
    },
    [api],
  )

  const switchBranch = useCallback(
    async (threadId: Id, leafId: Id): Promise<void> => {
      const response = await api.request("PATCH /threads/:id", { activeLeafId: leafId }, { id: threadId })
      setData((current) => ({ ...current, threads: uniqueById([...current.threads, response.thread]) }))
    },
    [api],
  )

  const updateBot = useCallback(
    async (botId: Id, patch: Partial<ApiRoutes["PATCH /bots/:id"]["req"]>): Promise<void> => {
      const response = await api.request("PATCH /bots/:id", patch, { id: botId })
      setData((current) => ({ ...current, bots: uniqueById([...current.bots, response.bot]) }))
    },
    [api],
  )

  const machineAction = useCallback(
    async (botId: Id, reset: boolean, projectId?: Id | null, stopTurns = false): Promise<void> => {
      const response = reset
        ? await api.request(
            "POST /bots/:id/machine/reset",
            { confirm: true, stopTurns, ...(projectId !== undefined ? { projectId } : {}) },
            { id: botId },
          )
        : await api.request("POST /bots/:id/machine/restart", { stopTurns }, { id: botId })
      setData((current) => ({
        ...current,
        machines: [...current.machines.filter((state) => state.botId !== botId), response.machine],
      }))
    },
    [api],
  )

  const createBot = useCallback(
    async (input: ApiRoutes["POST /bots"]["req"], loginDraftId?: string): Promise<void> => {
      const created = loginDraftId ? createdLoginDrafts.current.get(loginDraftId) : undefined
      const response = created ? { bot: created } : await api.request("POST /bots", input)
      if (loginDraftId) createdLoginDrafts.current.set(loginDraftId, response.bot)
      if (loginDraftId)
        await api.request(
          "POST /bots/:id/provider-login/flow",
          { provider: input.provider, action: "adopt", draftId: loginDraftId },
          { id: response.bot.id },
        )
      if (loginDraftId) createdLoginDrafts.current.delete(loginDraftId)
      setData((current) => ({
        ...current,
        bots: uniqueById([...current.bots, response.bot]),
        selectedBotId: response.bot.id,
        selectedThreadId: response.bot.mainThreadId,
        activeProjectId: response.bot.projectId,
        processes: [],
      }))
      const threadsResponse = await api.request("GET /bots/:id/threads", {}, { id: response.bot.id })
      setData((current) => ({
        ...current,
        threads: uniqueById([...current.threads, ...threadsResponse.threads]),
        selectedThreadId:
          current.selectedBotId === response.bot.id
            ? (threadsResponse.threads[0]?.id ?? null)
            : current.selectedThreadId,
      }))
    },
    [api],
  )

  const toggleRoutine = useCallback(
    async (routine: Routine): Promise<void> => {
      const response = await api.request("PATCH /routines/:id", { enabled: !routine.enabled }, { id: routine.id })
      setData((current) => ({
        ...current,
        routines: current.routines.map((candidate) => (candidate.id === routine.id ? response.routine : candidate)),
      }))
    },
    [api],
  )

  const runRoutine = useCallback(
    async (routineId: Id): Promise<void> => {
      const response = await api.request("POST /routines/:id/run", {}, { id: routineId })
      setData((current) => ({
        ...current,
        routineRuns: mergeRunRows(current.routineRuns, [response.routineRun]),
      }))
    },
    [api],
  )

  const createRoutine = useCallback(
    async (input: ApiRoutes["POST /routines"]["req"]): Promise<void> => {
      const response = await api.request("POST /routines", input)
      setData((current) => ({ ...current, routines: uniqueById([...current.routines, response.routine]) }))
    },
    [api],
  )

  const updateRoutine = useCallback(
    async (routineId: Id, patch: ApiRoutes["PATCH /routines/:id"]["req"]): Promise<void> => {
      const response = await api.request("PATCH /routines/:id", patch, { id: routineId })
      setData((current) => ({
        ...current,
        routines: current.routines.map((routine) => (routine.id === routineId ? response.routine : routine)),
      }))
    },
    [api],
  )

  const createProject = useCallback(
    async (input: ApiRoutes["POST /projects"]["req"]): Promise<Project> => {
      const response = await api.request("POST /projects", input)
      setData((current) => ({
        ...current,
        projects: [...current.projects.filter((project) => project.id !== response.project.id), response.project],
        previews: current.previews.filter((preview) => preview.projectId !== response.project.id),
      }))
      return response.project
    },
    [api],
  )

  const createProcess = useCallback(
    async (
      projectId: Id,
      name: string,
      input: ApiRoutes["PUT /projects/:id/processes/:name"]["req"],
    ): Promise<void> => {
      const bot = data.bots.find((bot) => bot.id === data.selectedBotId)
      const vmBotId = bot?.machine === "vm" ? bot.id : null
      await api.request("PUT /projects/:id/processes/:name", { ...input, vmBotId }, { id: projectId, name })
      const response = await api.request("GET /projects/:id/processes", vmBotId ? { vmBotId } : {}, { id: projectId })
      setData((current) => ({
        ...current,
        activeProjectId: projectId,
        processes: response.processes,
      }))
    },
    [api, data.bots, data.selectedBotId],
  )

  const startProcess = useCallback(
    async (processId: Id): Promise<void> => {
      const response = await api.request("POST /processes/:id/start", {}, { id: processId })
      setData((current) => ({
        ...current,
        processes: current.processes.map((entry) =>
          entry.spec.id === processId ? { ...entry, run: response.run } : entry,
        ),
      }))
      const previews = await api.request("GET /previews", {})
      setData((current) => ({ ...current, previews: previews.previews }))
    },
    [api],
  )

  const stopProcess = useCallback(
    async (processId: Id): Promise<void> => {
      const response = await api.request("POST /processes/:id/stop", {}, { id: processId })
      setData((current) => ({
        ...current,
        processes: current.processes.map((entry) =>
          entry.spec.id === processId ? { ...entry, run: response.run } : entry,
        ),
      }))
    },
    [api],
  )

  const restartProcess = useCallback(
    async (processId: Id): Promise<void> => {
      const response = await api.request("POST /processes/:id/restart", {}, { id: processId })
      setData((current) => ({
        ...current,
        processes: current.processes.map((entry) =>
          entry.spec.id === processId ? { ...entry, run: response.run } : entry,
        ),
      }))
      const previews = await api.request("GET /previews", {})
      setData((current) => ({ ...current, previews: previews.previews }))
    },
    [api],
  )

  const refreshProject = useCallback(async (): Promise<void> => {
    await loadProject(data.activeProjectId, selectedBot?.machine === "vm" ? selectedBot.id : undefined)
    const previews = await api.request("GET /previews", {})
    setData((current) => ({ ...current, previews: previews.previews }))
  }, [api, data.activeProjectId, loadProject, selectedBot])

  const selectLocation = useCallback(({ bot, thread }: { bot: Id | null; thread: Id | null }): void => {
    setData((current) => {
      const target = thread ? current.threads.find((candidate) => candidate.id === thread) : undefined
      const botId = target?.botId ?? bot
      if (!botId || !current.bots.some((candidate) => candidate.id === botId)) return current
      if (current.selectedBotId && current.selectedThreadId)
        threadsByBot.current[current.selectedBotId] = current.selectedThreadId
      const fallback = lastActiveThread(current.threads, current.runs, botId, threadsByBot.current[botId])
      return {
        ...current,
        selectedBotId: botId,
        activeProjectId: current.bots.find((candidate) => candidate.id === botId)?.projectId ?? null,
        processes: [],
        selectedThreadId: target?.id ?? fallback?.id ?? null,
        threads: current.threads.map((candidate) =>
          candidate.id === target?.id ? { ...candidate, unread: 0 } : candidate,
        ),
      }
    })
  }, [])

  const dismissNotification = useCallback(
    async (id: number): Promise<void> => {
      const response = await api.request("POST /notifications/:id/dismiss", {}, { id: String(id) })
      setData((current) => ({
        ...current,
        notifications: upsertNotification(current.notifications, response.notification),
      }))
    },
    [api],
  )

  const dismissAllNotifications = useCallback(async (): Promise<void> => {
    await api.request("POST /notifications/dismiss-all", {})
    const response = await api.request("GET /notifications", {})
    setData((current) => ({ ...current, notifications: response.notifications }))
  }, [api])

  const respondNotification = useCallback(
    async ({
      notification,
      behavior,
      message,
    }: {
      notification: NotificationRecord
      behavior: RespondBehavior
      message?: string
    }): Promise<void> => {
      if (!notification.threadId || !notification.requestId) return
      await api.request(
        "POST /threads/:id/respond",
        { requestId: notification.requestId, behavior, ...(message === undefined ? {} : { message }) },
        { id: notification.threadId },
      )
    },
    [api],
  )

  const replyToNotification = useCallback(
    async ({ notification, text }: { notification: NotificationRecord; text: string }): Promise<void> => {
      if (!notification.botId || !text.trim()) return
      const thread = data.threads.find(
        (thread) =>
          thread.id === (notification.threadId ?? data.bots.find((bot) => bot.id === notification.botId)?.mainThreadId),
      )
      if (api.sendMessage && thread) {
        await api.sendMessage({
          threadId: thread.id,
          parentId: thread.activeLeafId,
          text: text.trim(),
          attachmentIds: [],
        })
        return
      }
      await api.request(
        "POST /bots/:id/messages",
        {
          text: text.trim(),
          ...(notification.threadId ? { threadId: notification.threadId } : {}),
          sendId: crypto.randomUUID(),
        },
        { id: notification.botId },
      )
    },
    [api, data.threads, data.bots],
  )

  const updateSettings = useCallback(
    async (patch: Partial<ApiRoutes["PATCH /settings"]["req"]>): Promise<void> => {
      const response = await api.request("PATCH /settings", patch)
      setData((current) => ({ ...current, settings: response.settings }))
    },
    [api],
  )

  const activityMessages = useMemo(() => {
    const rows = new Map(
      data.activityMessages.map((message) => [JSON.stringify([message.threadId, message.id]), message]),
    )
    for (const message of data.messages) {
      const key = JSON.stringify([message.threadId, message.id])
      const activity = rows.get(key)
      if (
        activity &&
        ((activity.updatedSeq ?? 0) > (message.updatedSeq ?? 0) ||
          ((activity.updatedSeq ?? 0) === (message.updatedSeq ?? 0) && activity.updatedAt > message.updatedAt))
      )
        continue
      rows.set(key, message)
    }
    return reconcileApprovalMessages([...rows.values()], data.notifications)
  }, [data.activityMessages, data.messages, data.notifications])

  const approvalMessages = useMemo(
    () => reconcileApprovalMessages(data.messages, data.notifications),
    [data.messages, data.notifications],
  )
  const notifications = useMemo(
    () =>
      reconcileFailureNotifications(reconcileApprovalNotifications(data.notifications, activityMessages), data.runs),
    [activityMessages, data.notifications, data.runs],
  )

  return {
    data: {
      ...data,
      messages: approvalMessages,
      activityMessages,
      notifications,
      doctor: diagnosis.report,
      doctorError: diagnosis.error,
      selectedBotId: selectedBot?.id ?? data.selectedBotId,
      selectedThreadId: selectedThread?.id ?? data.selectedThreadId,
    },
    actions: {
      refresh: load,
      refreshDoctor: diagnosis.refresh,
      selectBot,
      selectThread,
      createGroup,
      createGroupThread,
      createThread,
      sendMessage,
      retryRun,
      cancelRun,
      switchBranch,
      updateBot,
      deleteBot: async (botId, name, deleteVolumes) => {
        await api.request("DELETE /bots/:id", { name, deleteVolumes }, { id: botId })
        setData((current) => withoutBot(current, botId))
      },
      createBot,
      machineAction,
      toggleRoutine,
      runRoutine,
      createRoutine,
      updateRoutine,
      createProject,
      createProcess,
      startProcess,
      stopProcess,
      restartProcess,
      refreshProject,
      updateSettings,
      selectLocation,
      dismissNotification,
      dismissAllNotifications,
      respondNotification,
      replyToNotification,
      dismissComputerGrant: () => setData((current) => ({ ...current, computerGrantRequest: null })),
      dismissNotice: () => setData((current) => ({ ...current, notice: null })),
    },
  }
}
