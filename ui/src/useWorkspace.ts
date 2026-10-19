import type {
  ApiRoutes,
  Bot,
  BotGroup,
  BrowserTabInfo,
  DoctorReport,
  GroupAction,
  GroupInput,
  HostKind,
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
import { isApprovalNoticeTitle } from "@touri/contracts/approval-summary"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { UiApi } from "./api/client"
import {
  countPendingRequests,
  reconcileApprovalMessages,
  reconcileApprovalNotifications,
  uniqueApprovalNotifications,
} from "./approvalState"
import { moveComposerDraft } from "./composerDraft"
import { isServiceUnavailable, userFacingError } from "./errors"
import { adoptProviderLogin } from "./features/bots/providerLogin"
import { useDoctorReport } from "./features/doctor/useDoctorReport"
import { localizeNotice, t } from "./i18n"
import { localResponseTimings } from "./localResponseTimings"
import { useMachineParking } from "./machineIntents"
import { reconcileFailureNotifications } from "./sidebarAttention"
import { getSidebarReadThreadIds } from "./sidebarThreads"
import { updateActivityStream } from "./workspaceMemory"
import { activeRun, activityMessage, retainWorkspace } from "./workspaceRetention"
import { readWorkspaceState, saveWorkspaceState, type ThreadCreationStatus } from "./workspaceState"

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
  workRuns: Array<Run>
  projects: Array<Project>
  processes: Array<ProcessEntry>
  previews: Array<PreviewTarget>
  browserTabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>
  routineHost: HostKind
  routines: Array<Routine>
  routineRuns: Array<RoutineRun>
  doctor: DoctorReport | null
  doctorError: string | null
  settings: ApiRoutes["GET /settings"]["res"]["settings"] | null
  selectedBotId: Id | null
  selectedThreadId: Id | null
  threadCreation: { thread: Thread; status: ThreadCreationStatus } | null
  composerKey: Id | null
  activeProjectId: Id | null
  loading: boolean
  botsLoaded: boolean
  /** A successful snapshot is required before a web deep link can be resolved. */
  loaded: boolean
  notice: string | null
  importProgress: { phase: string; done: number; total: number } | null
  computerGrantRequest: { threadId: Id } | null
  pendingRequestsOnReturn: number | null
  notifications: Array<NotificationRecord>
}

export type WorkspaceActions = {
  refresh: () => Promise<void>
  refreshDoctor: () => Promise<void>
  selectBot: (botId: Id) => void
  selectThread: (threadId: Id, options?: { readRoutineGroup: boolean }) => void
  createGroup: (input: GroupInput, id?: string) => Promise<void>
  createGroupThread: (id: string) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  createThread: () => Promise<void>
  sendMessage: (
    text: string,
    parentId?: Id | null,
    attachmentIds?: Array<Id>,
    groupAction?: GroupAction,
  ) => Promise<void>
  retryRun: (runId: Id) => Promise<void>
  cancelRun: (runId: Id) => Promise<void>
  switchBranch: (threadId: Id, leafId: Id) => Promise<void>
  updateBot: (botId: Id, patch: Partial<ApiRoutes["PATCH /bots/:id"]["req"]>) => Promise<void>
  deleteBot: (botId: Id, name: string, deleteVolumes: boolean) => Promise<void>
  machineAction: (botId: Id, reset: boolean, projectId?: Id | null, stopTurns?: boolean) => Promise<void>
  createBot: (
    input: ApiRoutes["POST /bots"]["req"],
    loginDraftId?: string,
  ) => Promise<{ loginReady: boolean; bot: Bot }>
  toggleRoutine: (routine: Routine) => Promise<void>
  runRoutine: (routineId: Id) => Promise<void>
  createRoutine: (input: ApiRoutes["POST /routines"]["req"]) => Promise<Routine>
  deleteRoutine: (routineId: Id) => Promise<void>
  updateRoutine: (routineId: Id, patch: ApiRoutes["PATCH /routines/:id"]["req"]) => Promise<Routine>
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
  dismissAllNotifications: () => Promise<{ skipped: number; skippedIds?: Array<number> }>
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
  workRuns: [],
  projects: [],
  processes: [],
  previews: [],
  browserTabs: [],
  routineHost: "computer",
  routines: [],
  routineRuns: [],
  doctor: null,
  doctorError: null,
  settings: null,
  selectedBotId: readWorkspaceState().botId ?? null,
  selectedThreadId: readWorkspaceState().threadId ?? null,
  threadCreation: null,
  composerKey: null,
  activeProjectId: null,
  loading: true,
  botsLoaded: false,
  loaded: false,
  notice: null,
  importProgress: null,
  computerGrantRequest: null,
  notifications: [],
  pendingRequestsOnReturn: null,
})

const uniqueById = <T extends { id: Id }>(rows: Array<T>): Array<T> => {
  const result = new Map<Id, T>()
  rows.forEach((row) => {
    result.set(row.id, row)
  })
  return [...result.values()]
}

const getRunPhase = (status: string): number | undefined => {
  if (status === "queued") return 0
  if (status === "starting") return 1
  if (status === "running") return 2

  return undefined
}

const mergeRunRows = <
  T extends { id: Id; status: string; finishedAt: number | null; providerStartedAt?: number | null },
>(
  current: T[],
  incoming: T[],
): T[] => {
  const rows = new Map(current.map((row) => [row.id, row]))
  for (const row of incoming) {
    const previous = rows.get(row.id)
    const previousPhase = previous ? getRunPhase(previous.status) : undefined
    const incomingPhase = getRunPhase(row.status)
    if (previousPhase !== undefined && incomingPhase !== undefined && incomingPhase < previousPhase) continue
    // A late acceptance can predate provider invocation.
    if (
      previous?.providerStartedAt != null &&
      row.providerStartedAt == null &&
      ["queued", "starting"].includes(row.status)
    )
      continue
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
    if (reasoning)
      parts[partIndex] = {
        ...(current?.type === "reasoning" ? current : {}),
        type: "reasoning",
        text: previous + suffix,
      }
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

const hasPartGap = (length: number, patches: Extract<UiEvent, { type: "message.parts" }>["parts"]): boolean => {
  let nextLength = length
  // Sort a fresh local copy because patch positions must be validated in order.
  for (const { partIndex } of [...patches].sort((a, b) => a.partIndex - b.partIndex)) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex > nextLength) return true
    nextLength = Math.max(nextLength, partIndex + 1)
  }
  return false
}

export const applyParts = (
  messages: Array<Message>,
  event: Extract<UiEvent, { type: "message.parts" }>,
): Array<Message> =>
  messages.map((message) => {
    if (message.id !== event.messageId || message.threadId !== event.threadId || message.status !== "streaming")
      return message
    if (event.updatedSeq !== undefined && event.updatedSeq <= (message.updatedSeq ?? 0)) return message
    if (event.generation !== undefined && event.generation < (message.generation ?? 0)) return message
    if (hasPartGap(message.parts.length, event.parts)) return message
    const parts = [...message.parts]
    // Sort a fresh batch copy while the local parts array avoids a copy for every streaming patch.
    for (const { partIndex, part } of [...event.parts].sort((a, b) => a.partIndex - b.partIndex)) {
      const previous = parts[partIndex]
      parts[partIndex] =
        part.type === "approval" &&
        part.decision === "pending" &&
        previous?.type === "approval" &&
        previous.approvalId === part.approvalId &&
        previous.decision !== "pending"
          ? previous
          : structuredClone(part)
    }
    return {
      ...message,
      parts,
      text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      updatedAt: event.updatedAt ?? Date.now(),
      ...(event.updatedSeq !== undefined ? { updatedSeq: event.updatedSeq } : {}),
      ...(event.generation !== undefined ? { generation: event.generation } : {}),
    }
  })

type MessageStreamEvent = Extract<UiEvent, { type: "message.delta" | "message.parts" }>
const applyStreamEvent = (messages: Array<Message>, event: MessageStreamEvent): Array<Message> =>
  event.type === "message.parts"
    ? applyParts(messages, event)
    : applyDelta(messages, event.messageId, event.delta, event.partIndex, event.offset, event)

const MAX_NOTIFICATIONS = 200
// A slow history request must not become an unbounded event cache. Overflow reloads a fresh snapshot.
const MAX_STREAM_BUFFER_BYTES = 256 * 1024
type ThreadLoad = {
  attempt: number
  promise: Promise<void>
  deltas: Array<MessageStreamEvent>
  bytes: number
  overflow: boolean
}
const bufferStreamEvent = (load: ThreadLoad | undefined, event: MessageStreamEvent): void => {
  if (!load || load.overflow) return
  // The pending loader shares this bounded replay buffer; reset it in place on overflow.
  load.bytes += JSON.stringify(event).length * 2
  if (load.deltas.length >= 512 || load.bytes > MAX_STREAM_BUFFER_BYTES) {
    load.overflow = true
    // Clearing the request-owned buffer in place releases payloads still captured by its callback.
    load.deltas.length = 0
  } else load.deltas.push(event)
}

const getWorkspaceWithoutGroup = (data: WorkspaceData, groupId: Id): WorkspaceData => {
  const threadIds = new Set(data.threads.filter((thread) => thread.groupId === groupId).map((thread) => thread.id))
  const threads = data.threads.filter((thread) => !threadIds.has(thread.id))
  const routineIds = new Set(
    data.routines.filter((routine) => routine.groupId === groupId).map((routine) => routine.id),
  )
  const isSelected = threadIds.has(data.selectedThreadId ?? "") || data.threadCreation?.thread.groupId === groupId
  const selectedBotId = data.bots.some((bot) => bot.id === data.selectedBotId)
    ? data.selectedBotId
    : (data.bots[0]?.id ?? null)
  const fallbackThread = threads.find((thread) => thread.botId === selectedBotId && !thread.groupId)

  return {
    ...data,
    groups: data.groups.filter((group) => group.id !== groupId),
    routines: data.routines.filter((routine) => !routineIds.has(routine.id)),
    routineRuns: data.routineRuns.filter((run) => !routineIds.has(run.routineId)),
    threads,
    messages: data.messages.filter((message) => !threadIds.has(message.threadId)),
    activityMessages: data.activityMessages.filter((message) => !threadIds.has(message.threadId)),
    runs: data.runs.filter((run) => !threadIds.has(run.threadId)),
    workRuns: data.workRuns.filter((run) => !threadIds.has(run.threadId)),
    notifications: data.notifications.filter((item) => !threadIds.has(item.threadId ?? "")),
    selectedBotId: isSelected ? selectedBotId : data.selectedBotId,
    selectedThreadId: isSelected ? (fallbackThread?.id ?? null) : data.selectedThreadId,
    threadCreation: data.threadCreation?.thread.groupId === groupId ? null : data.threadCreation,
    composerKey: isSelected ? null : data.composerKey,
    computerGrantRequest: threadIds.has(data.computerGrantRequest?.threadId ?? "") ? null : data.computerGrantRequest,
  }
}

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
    threadCreation: data.threadCreation?.thread.botId === botId ? null : data.threadCreation,
    composerKey: data.selectedBotId === botId ? null : data.composerKey,
    selectedThreadId:
      data.selectedBotId === botId || threadIds.has(data.selectedThreadId ?? "")
        ? (threads.find((thread) => thread.botId === selectedBotId)?.id ?? null)
        : data.selectedThreadId,
    messages: data.messages.filter((message) => !threadIds.has(message.threadId)),
    activityMessages: data.activityMessages.filter((message) => !threadIds.has(message.threadId)),
    runs: data.runs.filter((run) => run.botId !== botId),
    workRuns: data.workRuns.filter((run) => run.botId !== botId),
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
  // Snapshot merge order is not age: retain the newest server IDs at the history limit.
  // The merged list is newly allocated; order it once before applying the fixed history limit.
  return merged.sort((a, b) => b.id - a.id).slice(0, MAX_NOTIFICATIONS)
}

const getServiceErrorMessage = (error: unknown): string => {
  const message = userFacingError(error)
  if (!isServiceUnavailable(error)) return message

  // Notices retain text only, so preserve the connection classification without relying on E1009.
  return `SERVER_CONNECTION_FAILED: ${message}`
}

const lastActiveThread = (threads: Thread[], runs: Run[], botId: Id, rememberedId?: Id): Thread | undefined => {
  const candidates = threads.filter((thread) => thread.botId === botId && !thread.groupId)
  // Both filtered arrays are local; sort them once to choose the conversation without another copy.
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

const getDraftThread = (botId: Id, groupId?: Id): Thread => {
  const now = Date.now()
  return {
    id: groupId ? `draft:group:${groupId}` : `draft:bot:${botId}`,
    botId,
    groupId: groupId ?? null,
    parentThreadId: null,
    kind: "chat",
    title: t("New conversation"),
    activeLeafId: null,
    routineRunId: null,
    cwdOverride: null,
    unread: 0,
    carryoverNote: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
      turns: 0,
      contextTokens: null,
      contextWindow: null,
    },
    source: "local",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
}

export const useWorkspace = (api: UiApi, enabled = true): Workspace => {
  const diagnosis = useDoctorReport(api, enabled)
  const [data, setData] = useReducer(
    (current: WorkspaceData, update: (current: WorkspaceData) => WorkspaceData) => {
      const next = update(current)
      return next === current ? current : retainWorkspace(next, current)
    },
    undefined,
    emptyState,
  )
  const creatingThread = useRef(false)
  const currentData = useRef(data)
  currentData.current = data
  useMachineParking(api, data.bots, enabled && !data.loading)
  const privateThreads = useRef(new Set<string>())
  const deletedGroups = useRef(new Set<Id>())
  const threadsByBot = useRef(readWorkspaceState().threadsByBot ?? {})
  const generation = useRef(0)
  const runRevision = useRef(0)
  const liveRuns = useRef(new Map<Id, number>())
  const completedDuringLoad = useRef<Set<Id> | null>(null)
  const loadedThreads = useRef(new Map<Id, number>())
  const snapshotUnavailable = useRef(false)
  const serviceNotice = useRef<string | null>(null)
  const threadLoads = useRef(new Map<Id, ThreadLoad>())
  const projectGeneration = useRef(0)
  const [projectRevision, setProjectRevision] = useState(0)
  useEffect(() => {
    // React refs own the revision index; terminal IDs must not accumulate with durable history.
    const activeIds = new Set(data.runs.filter(activeRun).map((run) => run.id))
    for (const id of liveRuns.current.keys()) if (!activeIds.has(id)) liveRuns.current.delete(id)
  }, [data.runs])
  useEffect(() => {
    if (!data.loading && data.selectedBotId && !data.threadCreation) {
      if (data.selectedThreadId) threadsByBot.current[data.selectedBotId] = data.selectedThreadId
      saveWorkspaceState({
        botId: data.selectedBotId,
        threadId: data.selectedThreadId,
        threadsByBot: threadsByBot.current,
      })
    }
  }, [data.loading, data.selectedBotId, data.selectedThreadId, data.threadCreation])

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
    function loadThread(threadId: Id, force = false): Promise<void> {
      const attempt = generation.current
      const groupId = currentData.current.threads.find((thread) => thread.id === threadId)?.groupId
      const pending = threadLoads.current.get(threadId)
      if (pending?.attempt === attempt) return pending.promise
      if (!force && loadedThreads.current.get(threadId) === attempt) return Promise.resolve()
      const deltas: Array<MessageStreamEvent> = []
      const runsAtStart = runRevision.current
      const promise = Promise.all([
        api.request("GET /threads/:id/messages", { all: true }, { id: threadId }),
        api.request("GET /threads/:id/runs", { all: true }, { id: threadId }),
      ])
        .then(([messages, runs]) => {
          const load = threadLoads.current.get(threadId)
          if (
            attempt !== generation.current ||
            load?.promise !== promise ||
            currentData.current.selectedThreadId !== threadId
          )
            return
          loadedThreads.current.clear()
          if (load.overflow) return
          loadedThreads.current.set(threadId, attempt)
          setData((current) => {
            if (groupId && !current.groups.some((group) => group.id === groupId)) return current
            if (current.selectedThreadId !== threadId) return current

            return {
              ...current,
              messages: (api.pendingMessages?.() ?? [])
                .filter((message) => message.threadId === threadId)
                .reduce(
                  updateMessage,
                  deltas.reduce(applyStreamEvent, messages.messages).reduce(updateMessage, current.messages),
                ),
              runs: mergeRunRows(
                current.runs,
                runs.runs.filter((run) => (liveRuns.current.get(run.id) ?? 0) <= runsAtStart),
              ),
              notice: current.notice === serviceNotice.current ? null : current.notice,
            }
          })
        })
        .catch((error: unknown) => {
          if (attempt !== generation.current || threadLoads.current.get(threadId)?.promise !== promise) return

          const notice = t("Service request failed", { error: getServiceErrorMessage(error) })
          if (isServiceUnavailable(error)) serviceNotice.current = notice
          setData((current) => ({ ...current, notice }))
        })
        .finally(() => {
          const load = threadLoads.current.get(threadId)
          if (load?.promise !== promise) return
          threadLoads.current.delete(threadId)
          if (load.overflow && attempt === generation.current && currentData.current.selectedThreadId === threadId)
            void loadThread(threadId, true)
        })
      threadLoads.current.set(threadId, { attempt, promise, deltas, bytes: 0, overflow: false })
      return promise
    },
    [api],
  )

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return
    const attempt = ++generation.current
    // Pending callbacks share these request-owned arrays, so clear them before abandoning the loads.
    for (const load of threadLoads.current.values()) load.deltas.length = 0
    threadLoads.current.clear()
    loadedThreads.current.clear()
    const runsAtStart = runRevision.current
    const completedRuns = new Set<Id>()
    completedDuringLoad.current = completedRuns
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
        workResponse,
      ] = await Promise.all([
        api.request("GET /groups", {}).catch(() => ({ groups: [] })),
        api.request("GET /bots", {}).then((response) => {
          if (attempt === generation.current) {
            // The sidebar can render independently of machine, routine and history initialization.
            // Keep loaded false until the complete index can resolve saved selections and deep links.
            setData((current) => {
              const selectedBot = response.bots.find((bot) => bot.id === current.selectedBotId) ?? response.bots[0]
              return {
                ...current,
                bots: uniqueById(response.bots),
                botsLoaded: true,
                selectedBotId: selectedBot?.id ?? null,
                activeProjectId: selectedBot?.projectId ?? null,
              }
            })
          }
          return response
        }),
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
        api.request("GET /runs", {}),
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
        const threads = mergeThreads(current.threads, allThreads)
        // A newer run may have evicted a completed row while this snapshot was in flight.
        const incomingRuns = mergeRunRows(activityResponse.runs, workResponse.runs).filter(
          (run) => !completedRuns.has(run.id) && (liveRuns.current.get(run.id) ?? 0) <= runsAtStart,
        )
        const runIds = new Set(incomingRuns.map((run) => run.id))
        const runs = mergeRunRows(
          current.runs.filter(
            (run) =>
              !["queued", "starting", "running"].includes(run.status) ||
              runIds.has(run.id) ||
              (liveRuns.current.get(run.id) ?? 0) > runsAtStart,
          ),
          incomingRuns,
        )
        const selectedBot = current.bots.find((bot) => bot.id === current.selectedBotId) ?? current.bots[0]
        const selectedThread =
          threads.find((thread) => thread.id === current.selectedThreadId && thread.botId === selectedBot?.id) ??
          lastActiveThread(
            threads,
            runs,
            selectedBot?.id ?? "",
            current.selectedThreadId ?? threadsByBot.current[selectedBot?.id ?? ""],
          )
        const threadCreation = current.threadCreation?.thread.botId === selectedBot?.id ? current.threadCreation : null
        const selectedThreadId = threadCreation ? current.selectedThreadId : (selectedThread?.id ?? null)
        const notifications = current.notifications.reduce(upsertNotification, notificationsResponse.notifications)
        const pendingRequests = countPendingRequests(notifications, activityResponse.messages)
        return {
          ...current,
          groups: groupResponse?.groups ?? [],
          machineCapability: machineResponse.capability,
          machines: machineResponse.machines,
          threads,
          messages: (api.pendingMessages?.() ?? []).reduce(updateMessage, current.messages),
          activityMessages: current.activityMessages.reduce(
            updateMessage,
            activityResponse.messages.map(activityMessage),
          ),
          workRuns: mergeRunRows(
            workResponse.runs.filter((run) => !completedRuns.has(run.id)),
            current.workRuns.filter((run) => (liveRuns.current.get(run.id) ?? 0) > runsAtStart),
          ).filter((run) => ["queued", "starting", "running"].includes(run.status)),
          runs,
          projects: projectResponse.projects,
          previews: previewResponse.previews,
          browserTabs: browserResponse.tabs,
          routineHost: routinesResponse.hostKind ?? routinesResponse.host ?? "computer",
          routines: uniqueById(routinesResponse.routines),
          routineRuns: uniqueById(routineRunsResponse.routineRuns),
          settings: settingsResponse.settings,
          notifications,
          pendingRequestsOnReturn: pendingRequests || null,
          selectedBotId: selectedBot?.id ?? null,
          selectedThreadId,
          threadCreation,
          composerKey: selectedThreadId === current.selectedThreadId ? current.composerKey : null,
          activeProjectId: selectedBot?.projectId ?? null,
          loading: false,
          loaded: true,
          notice: null,
        }
      })
      snapshotUnavailable.current = false
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
      snapshotUnavailable.current = isServiceUnavailable(error)
      setData((current) => ({
        ...current,
        loading: false,
        notice: api.isMock
          ? "Demo data · sidecar services are optional"
          : t("Service request failed", { error: getServiceErrorMessage(error) }),
      }))
    } finally {
      if (attempt === generation.current) completedDuringLoad.current = null
    }
  }, [api, enabled, loadThread])

  const removeGroup = useCallback(
    (groupId: Id): void => {
      setData((current) => getWorkspaceWithoutGroup(current, groupId))
      if (deletedGroups.current.has(groupId)) return

      deletedGroups.current.add(groupId)
      // Deletion must replace a snapshot already in flight, including an existing resync.
      void load()
    },
    [load],
  )

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
    // Event replay repairs an existing snapshot; an incomplete snapshot needs another full load.
    // Reloading every conversation on every reconnect kept slow clients behind.
    const unsubscribe = api.subscribe((envelope: UiEventEnvelope) => {
      const event = envelope.event
      localResponseTimings().observe(event)
      if (event.type === "thread.updated" && event.thread.groupThreadId) {
        privateThreads.current.add(event.thread.id)
        return
      }
      if (
        (event.type === "message.created" || event.type === "message.updated") &&
        privateThreads.current.has(event.message.threadId)
      )
        return
      if (
        (event.type === "message.delta" || event.type === "message.parts") &&
        privateThreads.current.has(event.threadId)
      )
        return
      if (event.type === "transcript.resync") {
        resync()
        return
      }
      if (event.type === "group.deleted") {
        removeGroup(event.groupId)
        return
      }
      if (event.type === "message.delta" || event.type === "message.parts")
        bufferStreamEvent(threadLoads.current.get(event.threadId), event)
      if (event.type === "run.updated") {
        const revision = ++runRevision.current
        if (activeRun(event.run)) liveRuns.current.set(event.run.id, revision)
        else {
          liveRuns.current.delete(event.run.id)
          completedDuringLoad.current?.add(event.run.id)
        }
      }
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
            messages:
              event.message.threadId === current.selectedThreadId
                ? updateMessage(current.messages, event.message)
                : current.messages,
            activityMessages:
              event.message.threadId === current.selectedThreadId
                ? current.activityMessages
                : updateMessage(current.activityMessages, activityMessage(event.message)),
            threads:
              event.message.delivery && event.message.delivery.status !== "acked" && event.type === "message.created"
                ? current.threads.map((thread) =>
                    thread.id === event.message.threadId ? { ...thread, activeLeafId: event.message.id } : thread,
                  )
                : current.threads,
          }
        if (event.type === "message.delta" || event.type === "message.parts") {
          if (event.threadId !== current.selectedThreadId)
            return { ...current, activityMessages: updateActivityStream(current.activityMessages, event) }
          const message = current.messages.find((row) => row.id === event.messageId && row.threadId === event.threadId)
          const part = event.type === "message.delta" ? message?.parts[event.partIndex] : undefined
          const length = part?.type === "text" || part?.type === "reasoning" ? part.text.length : 0
          const gap =
            event.type === "message.delta"
              ? event.offset !== undefined && event.offset > length
              : hasPartGap(message?.parts.length ?? 0, event.parts)
          if (!message || gap) {
            // Unopened threads have no snapshot to repair; selection fetches their current history.
            if (event.threadId === current.selectedThreadId && !threadLoads.current.has(event.threadId))
              queueMicrotask(() => {
                if (currentData.current.selectedThreadId !== event.threadId) return
                void loadThread(event.threadId, true)
                bufferStreamEvent(threadLoads.current.get(event.threadId), event)
              })
          }
          return {
            ...current,
            messages: applyStreamEvent(current.messages, event),
          }
        }
        if (event.type === "run.updated")
          return {
            ...current,
            runs: mergeRunRows(current.runs, [event.run]),
            workRuns: mergeRunRows(current.workRuns, event.run.origin ? [event.run] : []).filter((run) =>
              ["queued", "starting", "running"].includes(run.status),
            ),
          }
        if (event.type === "routine.deleted")
          return { ...current, routines: current.routines.filter((routine) => routine.id !== event.routineId) }
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
        // Older computer grants open their existing card; their native echo is not an error.
        if (
          event.type === "notify" &&
          (event.title === "Computer use approval" || event.title.endsWith(": Computer use approval")) &&
          event.threadId
        )
          return { ...current, computerGrantRequest: { threadId: event.threadId } }
        // Approval notifications already have a review action; the headless host
        // also echoes native notifications as legacy notices.
        if (
          event.type === "notify" &&
          (event.kind === "approval" ||
            event.requestId ||
            event.notificationId !== undefined ||
            isApprovalNoticeTitle(event.title) ||
            current.notifications.some(
              (item) =>
                item.kind === "approval" &&
                item.threadId === event.threadId &&
                (item.title === event.title || event.title.endsWith(`: ${item.title}`)) &&
                item.body === event.body,
            ))
        )
          return current
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
    // Browsers can suspend a socket without closing it. Refresh attention on return even when
    // there was no reconnect frame; never re-send a request or a decision during recovery.
    let refreshing: Promise<void> | null = null
    const refreshAttention = (): void => {
      if (refreshing || currentData.current.loading) return
      const attempt = generation.current
      refreshing = Promise.all([api.request("GET /notifications", {}), api.request("GET /workspace/activity", {})])
        .then(async ([snapshot, activity]) => {
          if (!active || attempt !== generation.current) return
          setData((current) => {
            const notifications = current.notifications.reduce(upsertNotification, snapshot.notifications)
            const messages = reconcileApprovalMessages([...activity.messages, ...current.messages], notifications)
            return {
              ...current,
              notifications,
              messages: reconcileApprovalMessages(current.messages, notifications, activity.messages),
              activityMessages: current.activityMessages.reduce(updateMessage, activity.messages.map(activityMessage)),
              pendingRequestsOnReturn: countPendingRequests(notifications, messages),
            }
          })
          const threadId = currentData.current.threadCreation ? null : currentData.current.selectedThreadId
          if (threadId) await loadThread(threadId, true)
        })
        .catch(() => {
          /* Keep the last known requests visible until recovery succeeds. */
        })
        .finally(() => {
          refreshing = null
        })
    }
    let wasHidden = document.visibilityState === "hidden"
    const visibility = (): void => {
      if (document.visibilityState === "hidden") wasHidden = true
      else if (wasHidden) {
        wasHidden = false
        refreshAttention()
      }
    }
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("online", refreshAttention)
    const unsubscribeConnection = api.subscribeConnection?.((connected) => {
      if (!connected) return
      if (snapshotUnavailable.current || !currentData.current.loaded) {
        resync()
        return
      }
      refreshAttention()
    })
    // Subscribe first, then load: the snapshot starts where live delivery does.
    void (api.cursorReady?.() ?? Promise.resolve()).then(() => {
      if (active) void load()
    })
    return () => {
      active = false
      generation.current += 1
      // Pending callbacks share these request-owned arrays, so clear them before abandoning the loads.
      for (const load of threadLoads.current.values()) load.deltas.length = 0
      threadLoads.current.clear()
      loadedThreads.current.clear()
      liveRuns.current.clear()
      completedDuringLoad.current = null
      unsubscribe()
      unsubscribeConnection?.()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("online", refreshAttention)
    }
  }, [api, enabled, load, loadThread, removeGroup])

  const selectedBot = useMemo(
    () => data.bots.find((bot) => bot.id === data.selectedBotId) ?? null,
    [data.bots, data.selectedBotId],
  )
  const selectedThread = useMemo(
    () => data.threadCreation?.thread ?? data.threads.find((thread) => thread.id === data.selectedThreadId) ?? null,
    [data.threads, data.selectedThreadId, data.threadCreation],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and reconnect also refresh the selected transcript
  useEffect(() => {
    for (const id of loadedThreads.current.keys()) if (id !== data.selectedThreadId) loadedThreads.current.delete(id)
    for (const [id, load] of threadLoads.current) {
      if (id === data.selectedThreadId) continue
      // Clearing the request-owned buffer in place releases payloads still captured by its callback.
      load.deltas.length = 0
      threadLoads.current.delete(id)
    }
    if (enabled && !data.loading && data.selectedThreadId && !data.threadCreation)
      void loadThread(data.selectedThreadId)
  }, [enabled, data.loading, data.selectedThreadId, data.threadCreation, projectRevision, loadThread])

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
      if (current.selectedBotId && current.selectedThreadId && !current.threadCreation)
        threadsByBot.current[current.selectedBotId] = current.selectedThreadId
      const thread = lastActiveThread(current.threads, current.runs, botId, threadsByBot.current[botId])
      const bot = current.bots.find((candidate) => candidate.id === botId)
      if (!thread) {
        const draftThread = getDraftThread(botId)
        const composerKey = crypto.randomUUID()
        return {
          ...current,
          selectedBotId: botId,
          threadCreation: { thread: draftThread, status: "draft" },
          composerKey,
          selectedThreadId: draftThread.id,
          activeProjectId: bot?.projectId ?? null,
          processes: [],
        }
      }
      return {
        ...current,
        selectedBotId: botId,
        threadCreation: null,
        composerKey: null,
        selectedThreadId: thread.id,
        activeProjectId: bot?.projectId ?? null,
        processes: [],
      }
    })
  }, [])

  const selectThread = useCallback((threadId: Id, options?: { readRoutineGroup: boolean }): void => {
    setData((current) => {
      const readIds = options?.readRoutineGroup
        ? getSidebarReadThreadIds(
            current.threads,
            current.routineRuns,
            threadId,
            new Set(current.routines.map((routine) => routine.id)),
          )
        : new Set([threadId])

      return {
        ...current,
        selectedBotId: current.threads.find((thread) => thread.id === threadId)?.botId ?? current.selectedBotId,
        selectedThreadId: threadId,
        threadCreation: null,
        composerKey: null,
        threads: current.threads.map((thread) => (readIds.has(thread.id) ? { ...thread, unread: 0 } : thread)),
      }
    })
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
          threadCreation: null,
          composerKey: null,
        }))
      }
    },
    [api],
  )
  const startThread = useCallback(
    async (groupId?: Id): Promise<void> => {
      if (creatingThread.current || !selectedBot) return
      creatingThread.current = true
      const draftThread = data.threadCreation?.thread ?? getDraftThread(selectedBot.id, groupId)
      const composerKey = data.threadCreation ? data.composerKey : crypto.randomUUID()
      setData((current) => ({
        ...current,
        selectedThreadId: draftThread.id,
        threadCreation: { thread: draftThread, status: "pending" },
        composerKey,
      }))
      try {
        const response = groupId
          ? await api.request("POST /groups/:id/threads", { title: t("New conversation") }, { id: groupId })
          : await api.request("POST /threads", { botId: selectedBot.id, title: t("New conversation") })
        moveComposerDraft(draftThread.id, response.thread.id)
        setData((current) => ({
          ...current,
          threads: uniqueById([...current.threads, response.thread]),
          ...(current.selectedThreadId === draftThread.id
            ? { selectedThreadId: response.thread.id, selectedBotId: response.thread.botId, threadCreation: null }
            : {}),
        }))
      } catch {
        setData((current) =>
          current.selectedThreadId === draftThread.id
            ? { ...current, threadCreation: { thread: draftThread, status: "failed" } }
            : current,
        )
      } finally {
        creatingThread.current = false
      }
    },
    [api, selectedBot, data.threadCreation, data.composerKey],
  )
  useEffect(() => {
    if (data.threadCreation?.status === "draft" && selectedBot?.id === data.threadCreation.thread.botId)
      void startThread(data.threadCreation.thread.groupId ?? undefined)
  }, [data.threadCreation, selectedBot?.id, startThread])
  const createGroupThread = useCallback((id: string) => startThread(id), [startThread])
  const createThread = useCallback(
    () => startThread(selectedThread?.groupId ?? undefined),
    [startThread, selectedThread?.groupId],
  )

  const sendMessage = useCallback(
    async (
      text: string,
      parentId?: Id | null,
      attachmentIds: Array<Id> = [],
      groupAction?: GroupAction,
    ): Promise<void> => {
      if (creatingThread.current || data.threadCreation || selectedThread?.id !== currentData.current.selectedThreadId)
        throw new Error(t("Criando conversa…"))
      if (!selectedThread || !text.trim()) return
      const clientNonce = crypto.randomUUID()
      localResponseTimings().begin(selectedThread.id, clientNonce)
      const input = {
        clientNonce,
        threadId: selectedThread.id,
        parentId: parentId === undefined ? selectedThread.activeLeafId : parentId,
        text: text.trim(),
        attachmentIds,
        ...(groupAction ? { groupAction } : {}),
      }
      const response = api.sendMessage
        ? await api.sendMessage(input)
        : await api.request("POST /threads/:id/messages", input, { id: selectedThread.id })
      localResponseTimings().observe({ type: "message.updated", message: response.message })
      if (response.run) localResponseTimings().observe({ type: "run.updated", run: response.run })
      setData((current) => ({
        ...current,
        messages: updateMessage(current.messages, response.message),
        threads: current.threads.map((thread) =>
          thread.id === selectedThread.id ? { ...thread, activeLeafId: response.message.id } : thread,
        ),
        runs: response.run ? mergeRunRows(current.runs, [response.run]) : current.runs,
      }))
    },
    [api, selectedThread, data.threadCreation],
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
    async (input: ApiRoutes["POST /bots"]["req"], loginDraftId?: string) => {
      const response = await api.request("POST /bots", input)
      const [loginReady, threadsResponse] = await Promise.all([
        loginDraftId
          ? adoptProviderLogin(api, response.bot, loginDraftId).then(
              () => true,
              () => false,
            )
          : Promise.resolve(true),
        api.request("GET /bots/:id/threads", {}, { id: response.bot.id }).catch(() => ({ threads: [] })),
      ])
      // Adoption can enable the VM login after POST /bots. Its creation snapshot
      // must not overwrite that update, even when the event stream reconnects.
      const refreshedBot = loginDraftId
        ? (await api.request("GET /bots", {}).catch(() => ({ bots: [] }))).bots.find(
            (bot) => bot.id === response.bot.id,
          )
        : undefined
      setData((current) => {
        const bot = refreshedBot ?? current.bots.find((bot) => bot.id === response.bot.id) ?? response.bot
        return {
          ...current,
          bots: uniqueById([...current.bots, bot]),
          selectedBotId: bot.id,
          threads: mergeThreads(current.threads, threadsResponse.threads),
          selectedThreadId: bot.mainThreadId ?? threadsResponse.threads[0]?.id ?? null,
          threadCreation: null,
          composerKey: null,
          activeProjectId: bot.projectId,
          processes: [],
        }
      })
      return { loginReady, bot: refreshedBot ?? response.bot }
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
    async (input: ApiRoutes["POST /routines"]["req"]): Promise<Routine> => {
      const response = await api.request("POST /routines", input)
      setData((current) => ({ ...current, routines: uniqueById([...current.routines, response.routine]) }))
      return response.routine
    },
    [api],
  )

  const deleteRoutine = useCallback(
    async (routineId: Id): Promise<void> => {
      await api.request("DELETE /routines/:id", {}, { id: routineId })
      setData((current) => ({ ...current, routines: current.routines.filter((routine) => routine.id !== routineId) }))
    },
    [api],
  )

  const updateRoutine = useCallback(
    async (routineId: Id, patch: ApiRoutes["PATCH /routines/:id"]["req"]): Promise<Routine> => {
      const response = await api.request("PATCH /routines/:id", patch, { id: routineId })
      setData((current) => ({
        ...current,
        routines: current.routines.map((routine) => (routine.id === routineId ? response.routine : routine)),
      }))
      return response.routine
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
      if (current.selectedBotId && current.selectedThreadId && !current.threadCreation)
        threadsByBot.current[current.selectedBotId] = current.selectedThreadId
      const fallback = lastActiveThread(current.threads, current.runs, botId, threadsByBot.current[botId])
      return {
        ...current,
        selectedBotId: botId,
        threadCreation: null,
        composerKey: null,
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

  const dismissAllNotifications = useCallback(async () => {
    const result = await api.request("POST /notifications/dismiss-all", {})
    const response = await api.request("GET /notifications", {})
    setData((current) => ({ ...current, notifications: response.notifications }))
    return result
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
      reconcileFailureNotifications(
        uniqueApprovalNotifications(reconcileApprovalNotifications(data.notifications, activityMessages)),
        data.runs,
      ),
    [activityMessages, data.notifications, data.runs],
  )

  return {
    data: {
      ...data,
      messages: approvalMessages,
      activityMessages,
      notifications,
      pendingRequestsOnReturn:
        data.pendingRequestsOnReturn === null ? null : countPendingRequests(notifications, activityMessages),
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
      deleteGroup: async (id) => {
        await api.request("DELETE /groups/:id", {}, { id })
        removeGroup(id)
      },
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
      deleteRoutine,
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
      dismissNotice: () => setData((current) => ({ ...current, notice: null, pendingRequestsOnReturn: null })),
    },
  }
}
