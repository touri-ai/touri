import type {
  ApiRoutes,
  Bot,
  BotGroup,
  BrowserChannelRun,
  BrowserTabInfo,
  DoctorReport,
  GroupAction,
  GroupInput,
  HostKind,
  Id,
  MachineCapability,
  MachineState,
  Message,
  MessageHistoryContext,
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
import { canMarkNotificationRead } from "@touri/contracts"
import { isApprovalNoticeTitle } from "@touri/contracts/approval-summary"
import { startTransition, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { UiApi } from "./api/client"
import {
  countPendingRequests,
  reconcileApprovalMessages,
  reconcileApprovalNotifications,
  uniqueApprovalNotifications,
} from "./approvalState"
import { getChannelThreads } from "./channelThreads"
import { moveComposerDraft } from "./composerDraft"
import { getDocumentLocale } from "./documentLanguage"
import { ApiError, isServiceUnavailable, userFacingError } from "./errors"
import { adoptProviderLogin } from "./features/bots/providerLogin"
import { useDoctorReport } from "./features/doctor/useDoctorReport"
import { getHistoryFailure, getWithRetry, type HistoryFailure, isUnreachable } from "./historyFailure"
import { localizeNotice, t } from "./i18n"
import { localResponseTimings } from "./localResponseTimings"
import { useMachineParking } from "./machineIntents"
import { clearNotifications } from "./notificationClearing"
import { reconcileFailureNotifications } from "./sidebarAttention"
import { getSidebarReadThreadIds } from "./sidebarThreads"
import { getStorageScope } from "./storageScope"
import { createThreadHistoryCache, historyPageSize } from "./threadHistory"
import { getWorkChannelCache, saveWorkChannelCache } from "./workChannelCache"
import { updateActivityStream } from "./workspaceMemory"
import { activeRun, activityMessage, getRetainedActivity, retainWorkspace } from "./workspaceRetention"
import { readWorkspaceState, saveWorkspaceState, type ThreadCreationStatus } from "./workspaceState"

type ProcessEntry = { spec: ProcessSpec; run: ProcessRunState | null }

export type WorkspaceData = {
  groupsLoaded?: boolean
  readyGroupIds?: Id[]
  messageFocus?: { threadId: Id; messageId: Id; request: number; approvalId?: Id | undefined } | null
  historyContext?: MessageHistoryContext | undefined
  historyFocusId?: Id | null
  historyBefore?: Id | null | undefined
  historyRunsReady?: boolean
  loadingOlderHistory?: boolean
  historyThreadId?: Id | null
  historyNotice?: string | null
  /** The selected conversation's last failed read, shown inside the conversation instead of the app notice. */
  historyFailure?: HistoryFailure | null
  channelNotice?: string | null
  channelCacheIdentity?: { scope: string | null; personId: string }
  groups: Array<BotGroup>
  bots: Array<Bot>
  machineCapability: MachineCapability
  machines: Array<MachineState>
  threads: Array<Thread>
  deletedThreadIds?: ReadonlySet<Id>
  messages: Array<Message>
  activityMessages: Array<Message>
  runs: Array<Run>
  workRuns: Array<Run>
  projects: Array<Project>
  processes: Array<ProcessEntry>
  previews: Array<PreviewTarget>
  browserTabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>
  browserRuns?: Array<BrowserChannelRun>
  routineHost: HostKind
  routines: Array<Routine>
  routineRuns: Array<RoutineRun>
  doctor: DoctorReport | null
  doctorError: string | null
  isMember?: boolean
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
  notificationReads?: Array<NotificationReadReceipt>
}

type NotificationReadReceipt = Extract<UiEvent, { type: "notifications.read" }>["receipts"][number]

export type WorkspaceActions = {
  refresh: () => Promise<void>
  refreshDoctor: () => Promise<void>
  loadOlderMessages: () => Promise<void>
  prefetchThread: (threadId: Id) => void
  selectBot: (botId: Id) => void
  selectThread: (
    threadId: Id,
    options?: { readRoutineGroup?: boolean; messageId?: Id | undefined; approvalId?: Id | undefined },
  ) => void
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
  cancelRun: (runId: Id, scope?: "group" | "turn") => Promise<void>
  switchBranch: (threadId: Id, leafId: Id) => Promise<void>
  updateBot: (botId: Id, patch: Partial<ApiRoutes["PATCH /bots/:id"]["req"]>) => Promise<void>
  updateBotModel: (botId: Id, model: string | null) => Promise<void>
  deleteBot: (botId: Id, name: string, deleteVolumes: boolean) => Promise<void>
  archiveThread: (threadId: Id, archived: boolean) => Promise<Thread>
  archiveThreads: (threadIds: Array<Id>, archived: boolean) => Promise<void>
  deleteThread: (threadId: Id, botId: Id) => Promise<void>
  deleteThreads: (threadIds: Array<Id>, botId: Id) => Promise<void>
  getThreadDeletePreview: (threadId: Id) => Promise<ApiRoutes["GET /threads/:id/delete-preview"]["res"]>
  loadArchivedThreads: (botId: Id, before?: Id) => Promise<Array<Thread>>
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
  dismissAllNotifications: (ids: number[]) => Promise<{ skipped: number; skippedIds?: Array<number> }>
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
  browserRuns: [],
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
    // Activity summaries omit optional metadata already hydrated by the selected history.
    // Preserve those fields while allowing an explicit null to clear them.
    rows.set(row.id, { ...previous, ...row })
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
    const routineTitle = thread.routineTitle ?? (previous?.title === thread.title ? previous.routineTitle : undefined)
    rows.set(thread.id, { ...thread, routineTitle })
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
  controller: AbortController
  deltas: Array<MessageStreamEvent>
  bytes: number
  overflow: boolean
  historyReady?: boolean
  runsReady?: boolean
  terminalRevision: number
  repairMessageId: Id | null
  deferredDeltas: MessageStreamEvent[]
}
const bufferStreamEvent = (load: ThreadLoad | undefined, event: MessageStreamEvent): void => {
  if (!load || load.overflow || load.historyReady) return
  // The pending loader shares this bounded replay buffer; reset it in place on overflow.
  load.bytes += JSON.stringify(event).length * 2
  if (load.deltas.length >= 512 || load.bytes > MAX_STREAM_BUFFER_BYTES) {
    load.overflow = true
    // Clearing the request-owned buffer in place releases payloads still captured by its callback.
    load.deltas.length = 0
  } else load.deltas.push(event)
}

/** A failed conversation index keeps an open conversation readable and explains the failure inside it. */
export const getIndexFailure = (data: WorkspaceData, notice: string, error: unknown, isMock = false): WorkspaceData => {
  const threadId = data.selectedThreadId
  const isOpen = Boolean(threadId && data.threads.some((thread) => thread.id === threadId))
  if (isMock || !threadId || !isOpen || !isUnreachable(error))
    return { ...data, loading: false, notice, channelNotice: notice }

  return {
    ...data,
    loading: false,
    notice: null,
    channelNotice: null,
    historyFailure: { ...getHistoryFailure(error), threadId, index: true },
  }
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

const getWorkspaceWithoutThread = (data: WorkspaceData, threadId: Id, botIdHint?: Id): WorkspaceData =>
  getWorkspaceWithoutThreads(data, new Set([threadId]), botIdHint)

const getWorkspaceWithoutThreads = (data: WorkspaceData, threadIds: ReadonlySet<Id>, botIdHint?: Id): WorkspaceData => {
  const thread =
    data.threads.find((candidate) => candidate.id === data.selectedThreadId && threadIds.has(candidate.id)) ??
    data.threads.find((candidate) => threadIds.has(candidate.id))
  const botId = thread?.botId ?? botIdHint
  const threads = data.threads.filter((candidate) => !threadIds.has(candidate.id))
  const selected = threadIds.has(data.selectedThreadId ?? "")
  const bot = botId ? data.bots.find((candidate) => candidate.id === botId) : undefined
  const channelMain = thread?.groupId ? getChannelThreads(threads, thread.groupId)[0] : undefined
  const fallback =
    channelMain ??
    threads.find((candidate) => candidate.id === bot?.mainThreadId) ??
    threads.find((candidate) => candidate.botId === botId && !candidate.groupId && !candidate.archivedAt)

  return {
    ...data,
    threads,
    deletedThreadIds: new Set([...(data.deletedThreadIds ?? []), ...threadIds]),
    messages: data.messages.filter((message) => !threadIds.has(message.threadId)),
    activityMessages: data.activityMessages.filter((message) => !threadIds.has(message.threadId)),
    runs: data.runs.filter((run) => !threadIds.has(run.threadId)),
    routineRuns: data.routineRuns.map((run) => (threadIds.has(run.threadId ?? "") ? { ...run, threadId: null } : run)),
    workRuns: data.workRuns.filter((run) => !threadIds.has(run.threadId)),
    notifications: data.notifications.filter((item) => !threadIds.has(item.threadId ?? "")),
    selectedBotId: selected && botId ? botId : data.selectedBotId,
    selectedThreadId: selected ? (fallback?.id ?? null) : data.selectedThreadId,
    threadCreation: threadIds.has(data.threadCreation?.thread.id ?? "") ? null : data.threadCreation,
    composerKey: selected ? null : data.composerKey,
    computerGrantRequest: threadIds.has(data.computerGrantRequest?.threadId ?? "") ? null : data.computerGrantRequest,
  }
}

const getWorkspaceWithUpdatedThread = (data: WorkspaceData, thread: Thread): WorkspaceData => {
  if (data.deletedThreadIds?.has(thread.id)) return data
  const threads = mergeThreads(data.threads, [thread])
  if (thread.archivedAt === null || data.selectedThreadId !== thread.id) return { ...data, threads }
  const bot = data.bots.find((candidate) => candidate.id === thread.botId)
  const active = threads.filter(
    (candidate) => candidate.botId === thread.botId && candidate.archivedAt === null && !candidate.groupId,
  )
  const fallback = active.find((candidate) => candidate.id === bot?.mainThreadId) ?? active[0]

  return { ...data, threads, selectedThreadId: fallback?.id ?? null, threadCreation: null, composerKey: null }
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
    ? list.map((item) => (item.id === next.id ? getMergedNotification(item, next) : item))
    : [next, ...list]
  // Snapshot merge order is not age: retain the newest server IDs at the history limit.
  // ES2022 lacks immutable sorting; only this newly allocated list is sorted.
  return merged.sort((a, b) => b.id - a.id).slice(0, MAX_NOTIFICATIONS)
}

const getMergedNotification = (current: NotificationRecord, next: NotificationRecord): NotificationRecord => {
  const notification = current.resolvedAt !== null && next.resolvedAt === null ? current : next
  const readAt = Math.max(current.readAt ?? 0, next.readAt ?? 0) || null

  return Object.assign({}, notification, { readAt })
}

const getNotificationReads = (
  current: ReadonlyArray<NotificationReadReceipt>,
  incoming: ReadonlyArray<NotificationReadReceipt>,
): NotificationReadReceipt[] => {
  const previous = new Map(current.map((receipt) => [receipt.notificationId, receipt.readAt]))
  const updated = incoming.map((receipt) => ({
    notificationId: receipt.notificationId,
    readAt: Math.max(receipt.readAt, previous.get(receipt.notificationId) ?? 0),
  }))
  const receipts = new Map(current.concat(updated).map((receipt) => [receipt.notificationId, receipt]))

  // ES2022 lacks immutable sorting; sort only the disposable values array.
  return Array.from(receipts.values())
    .sort((left, right) => right.notificationId - left.notificationId)
    .slice(0, MAX_NOTIFICATIONS)
}

const getReadNotifications = (
  notifications: NotificationRecord[],
  receipts: ReadonlyArray<NotificationReadReceipt> = [],
): NotificationRecord[] => {
  const readAtById = new Map(receipts.map((receipt) => [receipt.notificationId, receipt.readAt]))

  return notifications.map((item) =>
    Object.assign({}, item, { readAt: Math.max(item.readAt ?? 0, readAtById.get(item.id) ?? 0) || null }),
  )
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

const isWorkRun = (run: Run): boolean =>
  run.status === "queued" || (run.kind !== "coordination" && ["starting", "running"].includes(run.status))

const getProcessVmBotId = (bot: Bot | undefined): Id | null => (bot?.machine === "vm" ? bot.id : null)

const isProcessScopeCurrent = (current: WorkspaceData, projectId: Id, vmBotId?: Id | null): boolean => {
  const bot = current.bots.find((candidate) => candidate.id === current.selectedBotId)

  return (
    current.activeProjectId === projectId &&
    bot?.projectId === projectId &&
    getProcessVmBotId(bot) === (vmBotId ?? null)
  )
}

/** Navigation and Preview use the same project/computer identity, including bot updates in place. */
const getProcessesForBot = (current: WorkspaceData, bot: Bot | undefined): ProcessEntry[] => {
  if (!bot?.projectId || current.activeProjectId !== bot.projectId) return []

  return current.processes.filter(
    (entry) => entry.spec.projectId === bot.projectId && (entry.spec.vmBotId ?? null) === getProcessVmBotId(bot),
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

// chatOpen: a draft only becomes a real thread while the chat it belongs to is on screen.
export const useWorkspace = (
  api: UiApi,
  enabled = true,
  chatOpen = true,
  role: "member" | "admin" | null = "admin",
  personId = "owner",
): Workspace => {
  const diagnosis = useDoctorReport(api, enabled && role === "admin")
  const historyCache = useRef(createThreadHistoryCache())
  const prefetchedThreads = useRef(new Map<Id, { controller: AbortController; promise: Promise<void> }>())
  const [data, setData] = useReducer(
    (current: WorkspaceData, update: (current: WorkspaceData) => WorkspaceData) => {
      const next = update(current)
      if (next === current) return current
      const selectionChanged = next.selectedThreadId !== current.selectedThreadId
      const resetHistory = selectionChanged && next.historyThreadId !== next.selectedThreadId

      const selectedHistory = next.threads.find((thread) => thread.id === next.selectedThreadId)
      const cached =
        (selectionChanged || (current.historyFocusId && !next.messageFocus)) &&
        next.selectedThreadId &&
        next.messageFocus?.threadId !== next.selectedThreadId
          ? historyCache.current.get(
              next.selectedThreadId,
              selectedHistory?.groupId ? undefined : selectedHistory?.activeLeafId,
            )
          : undefined
      const restored = cached
        ? {
            ...next,
            messages: cached.messages,
            runs: mergeRunRows(next.runs, cached.runs),
            historyThreadId: next.selectedThreadId,
            historyBefore: cached.before,
            historyRunsReady: cached.runsReady === true,
            historyFocusId: null,
            historyContext: cached.context,
            historyNotice: null,
            historyFailure: null,
            loadingOlderHistory: false,
          }
        : next
      const selected =
        resetHistory && !cached
          ? {
              ...restored,
              historyThreadId: null,
              historyBefore: undefined,
              historyRunsReady: false,
              historyContext: undefined,
              loadingOlderHistory: false,
            }
          : restored
      const focused = selected.messageFocus?.threadId === selected.selectedThreadId

      return retainWorkspace(focused ? selected : { ...selected, messageFocus: null }, current)
    },
    undefined,
    emptyState,
  )
  const creatingThread = useRef(false)
  // Bumped when a creation settles so a draft that waited on it is requested again.
  const [threadCreationSettled, settleThreadCreation] = useReducer((count: number) => count + 1, 0)
  const currentData = useRef(data)
  currentData.current = data
  useMachineParking(api, data.bots, enabled && !data.loading)
  const privateThreads = useRef(new Set<string>())
  const deletedGroups = useRef(new Set<Id>())
  const threadsByBot = useRef(readWorkspaceState().threadsByBot ?? {})
  const cachedGroupIds = useRef(new Set<string>())
  const generation = useRef(0)
  const runRevision = useRef(0)
  const liveRuns = useRef(new Map<Id, number>())
  const completedDuringLoad = useRef<Set<Id> | null>(null)
  const loadedThreads = useRef(new Map<Id, number>())
  const snapshotUnavailable = useRef(false)
  const serviceNotice = useRef<string | null>(null)
  const runNotice = useRef<string | null>(null)
  const threadLoads = useRef(new Map<Id, ThreadLoad>())
  const messageRepairs = useRef(new Map<string, { threadId: Id; messageId: Id }>())
  const unloadedStreams = useRef(new Set<string>())
  const recordUnloadedStream = useCallback((threadId: Id, messageId: Id): void => {
    unloadedStreams.current.add(getHistoryMessageKey(threadId, messageId))
    if (unloadedStreams.current.size <= 64) return
    const oldest = unloadedStreams.current.values().next().value
    if (oldest) unloadedStreams.current.delete(oldest)
  }, [])
  const historySelection = data.threads.find((thread) => thread.id === data.selectedThreadId)
  const historyLeafId = historySelection?.groupId ? null : historySelection?.activeLeafId
  useEffect(() => {
    const threadId = data.selectedThreadId
    if (
      !threadId ||
      data.historyThreadId !== threadId ||
      data.historyBefore === undefined ||
      data.historyFocusId ||
      loadedThreads.current.get(threadId) !== generation.current
    )
      return

    const leaf = historyLeafId ? data.messages.find((message) => message.id === historyLeafId) : undefined
    if (historyLeafId && !leaf) return
    historyCache.current.save(threadId, {
      messages: leaf ? data.messages.filter((message) => message.createdAt <= leaf.createdAt) : data.messages,
      runs: data.runs.filter((run) => run.threadId === threadId),
      runsReady: data.historyRunsReady === true,
      before: data.historyBefore,
      activeLeafId: historyLeafId,
      context: data.historyContext,
    })
  }, [
    data.selectedThreadId,
    data.historyThreadId,
    data.historyBefore,
    data.historyFocusId,
    data.historyContext,
    data.historyRunsReady,
    data.messages,
    data.runs,
    historyLeafId,
  ])
  const olderHistoryLoad = useRef<{ threadId: Id; controller: AbortController } | null>(null)
  const projectGeneration = useRef(0)
  const [projectRevision, setProjectRevision] = useState(0)
  useEffect(() => {
    if (!enabled || role === null) return
    const cached = getWorkChannelCache(personId)
    cachedGroupIds.current = new Set(cached?.groups.map((group) => group.id) ?? [])
    if (!cached) return

    setData((current) => {
      if (current.groupsLoaded) return current
      const selectedThreadId = cached.selectedThreadId ?? current.selectedThreadId
      return {
        ...current,
        groups: cached.groups,
        threads: mergeThreads(cached.threads, current.threads),
        selectedThreadId,
      }
    })
  }, [enabled, role, personId])
  useEffect(() => {
    const identity = data.channelCacheIdentity
    if (
      !enabled ||
      role === null ||
      !data.groupsLoaded ||
      !identity ||
      identity.personId !== personId ||
      identity.scope !== getStorageScope()
    )
      return
    // Coalesce metadata changes; the snapshot is capped at 64 KiB and contains no transcript.
    const snapshot = { groups: data.groups, threads: data.threads, selectedThreadId: data.selectedThreadId }
    const timer = setTimeout(() => saveWorkChannelCache(snapshot, personId, Date.now(), identity.scope), 100)
    return () => clearTimeout(timer)
  }, [
    enabled,
    role,
    personId,
    data.groupsLoaded,
    data.groups,
    data.threads,
    data.selectedThreadId,
    data.channelCacheIdentity,
  ])
  useEffect(() => {
    // React refs own the revision index; terminal IDs must not accumulate with durable history.
    const activeIds = new Set(data.runs.filter(activeRun).map((run) => run.id))
    for (const id of liveRuns.current.keys()) if (!activeIds.has(id)) liveRuns.current.delete(id)
  }, [data.runs])
  useEffect(() => {
    if (data.loading || !data.selectedBotId || data.threadCreation?.status === "pending") return

    const threadId = data.threadCreation ? null : data.selectedThreadId
    // The ref remembers visited conversations; local drafts never become history identifiers.
    if (threadId) threadsByBot.current[data.selectedBotId] = threadId
    saveWorkspaceState({
      botId: data.selectedBotId,
      threadId,
      threadsByBot: threadsByBot.current,
    })
  }, [data.loading, data.selectedBotId, data.selectedThreadId, data.threadCreation])

  const prefetchThread = useCallback(
    (threadId: Id): void => {
      if (
        threadId === currentData.current.selectedThreadId ||
        historyCache.current.get(threadId) ||
        prefetchedThreads.current.has(threadId)
      )
        return
      if (prefetchedThreads.current.size >= 2) return
      const controller = new AbortController()
      const attempt = generation.current
      const promise = api
        .request(
          "GET /threads/:id/messages",
          { all: true, limit: historyPageSize, context: true },
          { id: threadId },
          { signal: controller.signal },
        )
        .then((page) => {
          if (controller.signal.aborted || attempt !== generation.current || page.before === undefined) return
          // Hover warms messages only; run metadata must never hold up a channel click.
          historyCache.current.save(threadId, {
            messages: page.messages,
            runs: [],
            runsReady: false,
            before: page.before,
            activeLeafId: page.activeLeafId,
            context: page.context,
          })
        })
        .catch(() => undefined)
        .finally(() => {
          if (prefetchedThreads.current.get(threadId)?.controller === controller)
            prefetchedThreads.current.delete(threadId)
        })
      prefetchedThreads.current.set(threadId, { controller, promise })
    },
    [api],
  )

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    const { selectedThreadId: threadId, historyBefore: before, loadingOlderHistory } = currentData.current
    if (!threadId || !before || loadingOlderHistory || olderHistoryLoad.current) return
    const attempt = generation.current
    const controller = new AbortController()
    olderHistoryLoad.current = { threadId, controller }
    const timer = setTimeout(() => controller.abort(), 15_000)
    const isCurrent = (): boolean =>
      attempt === generation.current &&
      currentData.current.selectedThreadId === threadId &&
      olderHistoryLoad.current?.controller === controller
    setData((current) => ({ ...current, loadingOlderHistory: true }))
    try {
      const page = await api.request(
        "GET /threads/:id/messages",
        { all: true, limit: historyPageSize, before, context: true },
        { id: threadId },
        { signal: controller.signal },
      )
      if (!isCurrent()) return
      setData((current) => ({
        ...current,
        messages: getMergedHistoryMessages(page.messages, current.messages),
        historyBefore: page.before ?? null,
        historyContext: getMergedHistoryContext(current.historyContext, page.context),
      }))
      if (!page.messages.length) return
      const { runs } = await api.request(
        "GET /threads/:id/runs",
        { messageIds: page.messages.map((message) => message.id).join(",") },
        { id: threadId },
        { signal: controller.signal },
      )
      if (!isCurrent()) return
      setData((current) => ({ ...current, runs: mergeRunRows(current.runs, runs) }))
    } catch (error) {
      if (!isCurrent()) return
      setData((current) => ({
        ...current,
        notice: t("Service request failed", { error: getServiceErrorMessage(error) }),
      }))
    } finally {
      clearTimeout(timer)
      if (isCurrent()) setData((current) => ({ ...current, loadingOlderHistory: false }))
      if (olderHistoryLoad.current?.controller === controller) olderHistoryLoad.current = null
    }
  }, [api])

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
          isProcessScopeCurrent(current, projectId, vmBotId) ? { ...current, processes: response.processes } : current,
        )
      } catch {
        if (attempt !== generation.current || projectAttempt !== projectGeneration.current) return
        setData((current) =>
          isProcessScopeCurrent(current, projectId, vmBotId)
            ? { ...current, processes: [], notice: t("Project processes are unavailable.") }
            : current,
        )
      }
    },
    [api],
  )

  const loadThread = useCallback(
    function loadThread(threadId: Id, force = false, repairMessageId?: Id): Promise<void> {
      if (currentData.current.selectedThreadId !== threadId) return Promise.resolve()
      const attempt = generation.current
      const thread = currentData.current.threads.find((thread) => thread.id === threadId)
      const groupId = thread?.groupId
      const focus = currentData.current.messageFocus?.threadId === threadId ? currentData.current.messageFocus : null
      const pending = threadLoads.current.get(threadId)
      if (pending?.attempt === attempt && (!force || !pending.historyReady)) return pending.promise
      if (!force && loadedThreads.current.get(threadId) === attempt) return Promise.resolve()
      const prefetched = prefetchedThreads.current.get(threadId)
      if (!force && prefetched) return prefetched.promise.then(() => loadThread(threadId))
      const cached =
        !force && !focus ? historyCache.current.get(threadId, groupId ? undefined : thread?.activeLeafId) : undefined
      if (cached && cached.runsReady !== false) {
        loadedThreads.current.set(threadId, attempt)
        setData((current) =>
          current.selectedThreadId === threadId
            ? {
                ...current,
                messages: cached.messages,
                runs: mergeRunRows(current.runs, cached.runs),
                historyThreadId: threadId,
                historyBefore: cached.before,
                historyRunsReady: true,
                historyFocusId: null,
                historyContext: cached.context,
                historyNotice: null,
                historyFailure: null,
              }
            : current,
        )
        return Promise.resolve()
      }

      // Repairs must release the previous reader before starting another message/run pair.
      pending?.controller.abort()
      const controller = new AbortController()
      setData((current) => (current.historyRunsReady ? { ...current, historyRunsReady: false } : current))
      const deltas: Array<MessageStreamEvent> = []
      const isCurrentLoad = (): boolean =>
        attempt === generation.current &&
        threadLoads.current.get(threadId)?.promise === promise &&
        currentData.current.selectedThreadId === threadId
      // A transcript failure, or any read that never reached a stopped server, stays inside the conversation;
      // other run snapshot failures keep the app notice.
      const showReadFailure = (error: unknown, history: boolean): void => {
        if (!isCurrentLoad()) return

        const notice = t("Service request failed", { error: getServiceErrorMessage(error) })
        if (history || isUnreachable(error)) {
          setData((current) => ({
            ...current,
            historyNotice: notice,
            historyFailure: { ...getHistoryFailure(error), threadId },
          }))
          return
        }
        if (isServiceUnavailable(error)) serviceNotice.current = notice
        runNotice.current = notice
        setData((current) => ({ ...current, notice }))
      }
      const requestedIds = new Set(currentData.current.messages.map((message) => message.id))
      const pageTarget = repairMessageId ?? focus?.messageId
      const runPage = {
        all: true,
        limit: repairMessageId ? 1 : historyPageSize,
        ...(pageTarget ? { around: pageTarget } : {}),
      }
      const pageInput = { ...runPage, ...(!repairMessageId && (!groupId || focus) ? { context: true } : {}) }
      if (repairMessageId) messageRepairs.current.delete(getHistoryMessageKey(threadId, repairMessageId))
      const pageRequest = cached
        ? Promise.resolve({
            messages: cached.messages,
            activeLeafId: cached.activeLeafId ?? null,
            before: cached.before,
            context: cached.context,
          })
        : getWithRetry(
            () => api.request("GET /threads/:id/messages", pageInput, { id: threadId }, { signal: controller.signal }),
            { signal: controller.signal },
          )
      const messagesRequest = pageRequest
        .then((messages) => {
          const load = threadLoads.current.get(threadId)
          if (!isCurrentLoad() || !load) return
          loadedThreads.current.clear()
          if (load.overflow) return

          // The request owns its overlap buffer; release it as soon as messages are readable.
          const replay = deltas.slice()
          load.historyReady = true
          load.deltas.length = 0
          load.deferredDeltas.length = 0
          loadedThreads.current.set(threadId, attempt)
          const snapshot = repairMessageId
            ? messages.messages.filter((message) => message.id === repairMessageId)
            : messages.messages
          snapshot.forEach((message) => {
            messageRepairs.current.delete(getHistoryMessageKey(threadId, message.id))
          })
          load.deferredDeltas = replay.filter((event) =>
            messageRepairs.current.has(getHistoryMessageKey(event.threadId, event.messageId)),
          )
          if (
            repairMessageId &&
            (!snapshot.length || snapshot.some((message) => isUnloadedHistoryMessage(currentData.current, message)))
          )
            recordUnloadedStream(threadId, repairMessageId)
          setData((current) => {
            if (groupId && !current.groups.some((group) => group.id === groupId)) return current
            if (current.selectedThreadId !== threadId) return current

            const branchLeaf =
              !groupId && !repairMessageId
                ? snapshot.find((message) => message.id === messages.activeLeafId)
                : undefined
            const offscreen = repairMessageId
              ? snapshot.find((message) => isUnloadedHistoryMessage(current, message))
              : undefined
            const pageMessages = offscreen ? [] : snapshot
            const previous = current.messages.filter((message) => {
              if (branchLeaf && requestedIds.has(message.id) && message.createdAt > branchLeaf.createdAt) return false
              if (
                messages.before &&
                !repairMessageId &&
                !requestedIds.has(message.id) &&
                pageMessages[0] &&
                message.createdAt < pageMessages[0].createdAt
              )
                return false

              return true
            })
            const retainWindow = current.historyThreadId === threadId && current.historyBefore !== undefined
            const canClearNotice =
              current.notice !== runNotice.current &&
              (current.notice === serviceNotice.current || current.notice === current.historyNotice)
            return {
              ...current,
              historyThreadId: threadId,
              historyBefore: retainWindow ? current.historyBefore : messages.before,
              historyContext: repairMessageId ? current.historyContext : messages.context,
              historyFocusId: repairMessageId ? (current.historyFocusId ?? null) : (focus?.messageId ?? null),
              activityMessages: offscreen
                ? updateMessage(current.activityMessages, activityMessage(offscreen))
                : current.activityMessages,
              historyNotice: null,
              historyFailure: current.historyFailure?.index ? current.historyFailure : null,
              messages: (api.pendingMessages?.() ?? [])
                .filter((message) => message.threadId === threadId)
                .reduce(
                  updateMessage,
                  getMergedHistoryMessages(replay.reduce(applyStreamEvent, pageMessages), previous),
                ),
              notice: canClearNotice ? null : current.notice,
            }
          })
        })
        .catch((error: unknown) => showReadFailure(error, true))
        .finally(() => {
          const load = threadLoads.current.get(threadId)
          if (!isCurrentLoad() || !load) return
          load.historyReady = true
          if (load.overflow) {
            void loadThread(threadId, true, repairMessageId)
            return
          }
          const next = Array.from(messageRepairs.current.values()).find((repair) => repair.threadId === threadId)
          if (!next) return
          void loadThread(threadId, true, next.messageId)
          const pending = threadLoads.current.get(threadId)
          load.deferredDeltas.forEach((event) => {
            bufferStreamEvent(pending, event)
          })
          load.deferredDeltas.length = 0
        })
      const loadRuns = async (): Promise<void> => {
        // Retry one read at a time; a terminal-heavy stream must not build a chain of pending promises.
        for (;;) {
          const runsAtStart = runRevision.current
          const terminalRevision = threadLoads.current.get(threadId)?.terminalRevision ?? 0
          const runs = await api.request(
            "GET /threads/:id/runs",
            runPage,
            { id: threadId },
            { signal: controller.signal },
          )
          const load = threadLoads.current.get(threadId)
          if (!isCurrentLoad() || !load) return
          // A single watermark outlives pruned terminal rows without retaining completed IDs.
          if (load.terminalRevision !== terminalRevision) continue

          load.runsReady = true
          const previousNotice = runNotice.current
          runNotice.current = null
          setData((current) => ({
            ...current,
            historyRunsReady: true,
            notice:
              current.notice === previousNotice && current.historyNotice !== previousNotice ? null : current.notice,
            runs: mergeRunRows(
              current.runs,
              runs.runs.filter((run) => (liveRuns.current.get(run.id) ?? 0) <= runsAtStart),
            ),
          }))
          return
        }
      }
      const runsRequest = loadRuns().catch(async (error: unknown) => {
        showReadFailure(error, false)
        if (!isUnreachable(error)) return

        // Successful messages must not clear the connection failure of their companion run read.
        await messagesRequest
        showReadFailure(error, false)
      })
      const promise = Promise.all([messagesRequest, runsRequest])
        .then(() => undefined)
        .finally(() => {
          const load = threadLoads.current.get(threadId)
          if (load?.promise !== promise) return
          threadLoads.current.delete(threadId)
        })
      threadLoads.current.set(threadId, {
        attempt,
        promise,
        controller,
        deltas,
        bytes: 0,
        overflow: false,
        terminalRevision: pending?.terminalRevision ?? 0,
        repairMessageId: repairMessageId ?? null,
        deferredDeltas: [],
      })
      return promise
    },
    [api, recordUnloadedStream],
  )

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return
    // The server authorizes fresh reads while session identity retries; only the local cache must wait.
    const threadsAtStart = new Map(currentData.current.threads.map((thread) => [thread.id, thread]))
    const attempt = ++generation.current
    historyCache.current.clear()
    messageRepairs.current.clear()
    unloadedStreams.current.clear()
    prefetchedThreads.current.forEach(({ controller }) => {
      controller.abort()
    })
    prefetchedThreads.current.clear()
    const channelCacheIdentity = { scope: getStorageScope(), personId }
    setData((current) => ({ ...current, groupsLoaded: false, readyGroupIds: [] }))
    // Pending callbacks share these request-owned arrays, so clear them before abandoning the loads.
    for (const load of threadLoads.current.values()) {
      load.controller.abort()
      load.deltas.length = 0
    }
    threadLoads.current.clear()
    loadedThreads.current.clear()
    const runsAtStart = runRevision.current
    const completedRuns = new Set<Id>()
    completedDuringLoad.current = completedRuns
    const selected = currentData.current
    const cachedThread = selected.threads.find(
      (thread) =>
        thread.id === selected.selectedThreadId && thread.groupId && cachedGroupIds.current.has(thread.groupId),
    )
    // Cached metadata selects a request, never access; the event cursor still precedes the snapshot.
    if (role !== null && cachedThread && !selected.threadCreation)
      void (api.cursorReady?.() ?? Promise.resolve()).then(() => {
        if (attempt !== generation.current || currentData.current.selectedThreadId !== cachedThread.id) return

        return loadThread(cachedThread.id)
      })

    try {
      const member = role === "member"
      const restricted = role !== "admin"
      // Channels publish as each read finishes, independently of machines, routines and bot histories.
      const groupsRequest = api
        .request("GET /groups", {})
        .then((response) => {
          if (attempt === generation.current) setData((current) => ({ ...current, groups: response.groups }))
          return { ...response, loaded: true, notice: null }
        })
        .catch((error: unknown) => ({
          groups: [],
          loaded: false,
          notice: t("Service request failed", { error: getServiceErrorMessage(error) }),
        }))
      const groupThreadsRequest = groupsRequest
        .then(({ groups }) =>
          Promise.all(
            groups.map(async (group) => {
              const response = await api.request("GET /groups/:id/threads", {}, { id: group.id })
              if (attempt === generation.current)
                setData((current) =>
                  Object.assign({}, current, {
                    threads: mergeThreads(current.threads, response.threads),
                    readyGroupIds: (current.readyGroupIds ?? []).filter((id) => id !== group.id).concat(group.id),
                  }),
                )
              return response
            }),
          ),
        )
        .then(async (responses) => {
          const response = await groupsRequest
          if (response.loaded && attempt === generation.current)
            setData((current) => ({ ...current, groupsLoaded: true, channelCacheIdentity }))
          return responses
        })
      // Attach a rejection handler immediately, including when another startup resource fails first.
      void groupThreadsRequest.catch(() => undefined)
      const botsRequest = api.request("GET /bots", {}).then((response) => {
        if (attempt !== generation.current) return response

        // The sidebar can render before the complete index resolves saved selections and deep links.
        setData((current) => {
          const selectedBot = response.bots.find((bot) => bot.id === current.selectedBotId) ?? response.bots[0]

          return Object.assign({}, current, {
            bots: uniqueById(response.bots),
            botsLoaded: true,
            isMember: member,
            selectedBotId: member ? null : (selectedBot?.id ?? null),
            activeProjectId: selectedBot?.projectId ?? null,
          })
        })
        return response
      })
      // Conversation indexes depend only on authorized bots, not machines, routines or previews.
      const botThreadsRequest = botsRequest.then(({ bots }) =>
        Promise.all(
          bots.map(async (bot) => {
            const response = await api.request("GET /bots/:id/threads", {}, { id: bot.id })

            return response.threads
          }),
        ),
      )
      void botThreadsRequest.catch(() => undefined)
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
        groupsRequest,
        botsRequest,
        restricted ? { projects: [] } : getOptionalWorkspaceRead(api.request("GET /projects", {}), { projects: [] }),
        restricted
          ? { settings: null }
          : getOptionalWorkspaceRead(api.request("GET /settings", {}), { settings: null }),
        restricted ? { previews: [] } : getOptionalWorkspaceRead(api.request("GET /previews", {}), { previews: [] }),
        (restricted ? Promise.resolve({ tabs: [] }) : api.request("GET /browser/tabs", {})).catch(() => ({ tabs: [] })),
        restricted
          ? { routines: [], host: undefined, hostKind: undefined }
          : getOptionalWorkspaceRead(api.request("GET /routines", {}), {
              routines: [],
              host: undefined,
              hostKind: undefined,
            }),
        (restricted ? Promise.resolve({ routineRuns: [] }) : api.request("GET /routine-runs", {})).catch(() => ({
          routineRuns: [],
        })),
        api.request("GET /notifications", {}).catch(() => ({ notifications: [] })),
        (restricted
          ? Promise.resolve({ capability: { available: false, reason: "", provider: null }, machines: [] })
          : api.request("GET /machines", {})
        ).catch(() => ({
          capability: { available: false, reason: t("No virtualization on this host"), provider: null },
          machines: [],
        })),
        api.request("GET /workspace/activity", {}),
        api.request("GET /runs", {}),
      ])
      const [botThreads, groupThreads] = await Promise.all([botThreadsRequest, groupThreadsRequest])
      const allThreads = [...botThreads.flat(), ...groupThreads.flatMap((r) => r.threads)]
      if (attempt !== generation.current) return
      setData((current) => {
        const incoming = allThreads.filter((thread) => !current.deletedThreadIds?.has(thread.id))
        const incomingIds = new Set(incoming.map((thread) => thread.id))
        const groupIds = new Set(groupResponse.groups.map((group) => group.id))
        const changedDuringLoad = current.threads.filter(
          (thread) =>
            !current.deletedThreadIds?.has(thread.id) &&
            (!thread.groupId ||
              !cachedGroupIds.current.has(thread.groupId) ||
              !groupResponse.loaded ||
              groupIds.has(thread.groupId)) &&
            (incomingIds.has(thread.id) ||
              (!groupResponse.loaded && !!thread.groupId) ||
              thread !== threadsAtStart.get(thread.id)),
        )
        const threads = mergeThreads(changedDuringLoad, incoming)
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
        const channelThread = member ? threads.find((thread) => thread.groupId) : undefined
        const selectedThread =
          channelThread ??
          threads.find((thread) => thread.id === current.selectedThreadId && thread.groupId) ??
          threads.find((thread) => thread.id === current.selectedThreadId && thread.botId === selectedBot?.id) ??
          lastActiveThread(
            threads,
            runs,
            selectedBot?.id ?? "",
            current.selectedThreadId ?? threadsByBot.current[selectedBot?.id ?? ""],
          )
        const keptCreation =
          !member && current.threadCreation?.thread.botId === selectedBot?.id ? current.threadCreation : null
        // A bot selected at startup without conversations opens the same draft a click would.
        const selectionLost =
          !current.selectedThreadId || !threads.some((thread) => thread.id === current.selectedThreadId)
        const threadCreation: WorkspaceData["threadCreation"] =
          keptCreation ??
          (role === "admin" && selectedBot && !selectedThread && selectionLost
            ? { thread: getDraftThread(selectedBot.id), status: "draft" }
            : null)
        const selectedThreadId = threadCreation ? threadCreation.thread.id : (selectedThread?.id ?? null)
        const notifications = getReadNotifications(
          current.notifications.reduce(upsertNotification, notificationsResponse.notifications),
          current.notificationReads,
        )
        const pendingRequests = countPendingRequests(notifications, activityResponse.messages)
        return {
          ...current,
          isMember: member,
          groups: groupResponse.loaded ? groupResponse.groups : current.groups,
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
          ).filter(isWorkRun),
          runs,
          projects: projectResponse.projects,
          previews: previewResponse.previews,
          browserTabs: browserResponse.tabs,
          browserRuns: activityResponse.browserRuns ?? [],
          routineHost: routinesResponse.hostKind ?? routinesResponse.host ?? "computer",
          routines: uniqueById(routinesResponse.routines),
          routineRuns: uniqueById(routineRunsResponse.routineRuns),
          settings: settingsResponse.settings,
          notifications,
          pendingRequestsOnReturn: pendingRequests || null,
          selectedBotId: selectedThread?.botId ?? selectedBot?.id ?? null,
          selectedThreadId,
          threadCreation,
          composerKey:
            selectedThreadId === current.selectedThreadId
              ? current.composerKey
              : threadCreation
                ? crypto.randomUUID()
                : null,
          activeProjectId: selectedBot?.projectId ?? null,
          loading: false,
          loaded: true,
          notice: groupResponse.notice ?? null,
          channelNotice: groupResponse.notice,
          historyFailure: current.historyFailure?.index ? null : (current.historyFailure ?? null),
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
      const notice = api.isMock
        ? "Demo data · sidecar services are optional"
        : t("Service request failed", { error: getServiceErrorMessage(error) })
      setData((current) => getIndexFailure(current, notice, error, api.isMock))
    } finally {
      if (attempt === generation.current) completedDuringLoad.current = null
    }
  }, [api, enabled, loadThread, role, personId])

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
      if (event.type === "browser.channel_run") {
        setData((current) =>
          Object.assign({}, current, {
            browserRuns: (current.browserRuns ?? [])
              .filter((run) => run.runId !== event.run.runId)
              .concat(event.run)
              .slice(-200),
          }),
        )
        return
      }
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
      if (event.type === "thread.deleted") {
        historyCache.current.remove(event.threadId)
        prefetchedThreads.current.get(event.threadId)?.controller.abort()
        privateThreads.current.delete(event.threadId)
        loadedThreads.current.delete(event.threadId)
        const load = threadLoads.current.get(event.threadId)
        if (load) {
          load.controller.abort()
          load.deltas.length = 0
          load.deferredDeltas.length = 0
        }
        threadLoads.current.delete(event.threadId)
        setData((current) => getWorkspaceWithoutThread(current, event.threadId, event.botId))
        return
      }
      if (event.type === "group.deleted") {
        historyCache.current.clear()
        prefetchedThreads.current.forEach(({ controller }) => {
          controller.abort()
        })
        removeGroup(event.groupId)
        return
      }
      const changedThreadId = getHistoryEventThreadId(event)
      if (typeof changedThreadId === "string" && changedThreadId !== currentData.current.selectedThreadId) {
        historyCache.current.remove(changedThreadId)
      }
      if (typeof changedThreadId === "string") prefetchedThreads.current.get(changedThreadId)?.controller.abort()
      if (event.type === "message.updated" && isUnloadedHistoryMessage(currentData.current, event.message))
        recordUnloadedStream(event.message.threadId, event.message.id)
      if (event.type === "message.delta" || event.type === "message.parts")
        bufferStreamEvent(threadLoads.current.get(event.threadId), event)
      if (event.type === "run.updated") {
        const revision = ++runRevision.current
        if (activeRun(event.run)) liveRuns.current.set(event.run.id, revision)
        else {
          liveRuns.current.delete(event.run.id)
          completedDuringLoad.current?.add(event.run.id)
          const load = threadLoads.current.get(event.run.threadId)
          if (load) load.terminalRevision = revision
        }
      }
      const updateWorkspace = (current: WorkspaceData): WorkspaceData => {
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
        if (event.type === "bot.updated")
          return {
            ...current,
            bots: uniqueById([...current.bots, event.bot]),
            processes:
              event.bot.id === current.selectedBotId ? getProcessesForBot(current, event.bot) : current.processes,
          }
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
          return getWorkspaceWithUpdatedThread(
            {
              ...current,
              selectedBotId: current.selectedThreadId === event.thread.id ? event.thread.botId : current.selectedBotId,
            },
            event.thread,
          )
        if (event.type === "message.created" || event.type === "message.updated") {
          const unloaded = event.type === "message.updated" && isUnloadedHistoryMessage(current, event.message)
          return {
            ...current,
            messages:
              event.message.threadId === current.selectedThreadId && !unloaded
                ? updateMessage(current.messages, event.message)
                : current.messages,
            activityMessages:
              event.message.threadId === current.selectedThreadId && !unloaded
                ? current.activityMessages
                : updateMessage(current.activityMessages, activityMessage(event.message)),
            threads:
              event.message.delivery && event.message.delivery.status !== "acked" && event.type === "message.created"
                ? current.threads.map((thread) =>
                    thread.id === event.message.threadId ? { ...thread, activeLeafId: event.message.id } : thread,
                  )
                : current.threads,
          }
        }
        if (event.type === "message.delta" || event.type === "message.parts") {
          if (event.threadId !== current.selectedThreadId)
            return { ...current, activityMessages: updateActivityStream(current.activityMessages, event) }
          const message = current.messages.find((row) => row.id === event.messageId && row.threadId === event.threadId)
          const summary = current.activityMessages.find(
            (row) => row.id === event.messageId && row.threadId === event.threadId,
          )
          const unloaded =
            !message &&
            (unloadedStreams.current.has(getHistoryMessageKey(event.threadId, event.messageId)) ||
              isUnloadedHistoryMessage(current, summary))
          if (unloaded) return { ...current, activityMessages: updateActivityStream(current.activityMessages, event) }
          const part = event.type === "message.delta" ? message?.parts[event.partIndex] : undefined
          const length = part?.type === "text" || part?.type === "reasoning" ? part.text.length : 0
          const gap =
            event.type === "message.delta"
              ? event.offset !== undefined && event.offset > length
              : hasPartGap(message?.parts.length ?? 0, event.parts)
          if (!message || gap) {
            queueMicrotask(() => {
              if (currentData.current.selectedThreadId !== event.threadId) return
              const load = threadLoads.current.get(event.threadId)
              const key = getHistoryMessageKey(event.threadId, event.messageId)
              if (
                (!load || load.historyReady || load.repairMessageId !== event.messageId) &&
                messageRepairs.current.size < 64
              )
                messageRepairs.current.set(key, { threadId: event.threadId, messageId: event.messageId })
              if (!load || load.historyReady) {
                const next = Array.from(messageRepairs.current.values()).find(
                  (repair) => repair.threadId === event.threadId,
                )
                if (next) {
                  const ready =
                    currentData.current.historyThreadId === event.threadId &&
                    currentData.current.historyBefore !== undefined
                  void loadThread(event.threadId, true, ready ? next.messageId : undefined)
                }
              }
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
            workRuns: mergeRunRows(current.workRuns, event.run.origin ? [event.run] : []).filter(isWorkRun),
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
            previews: [
              ...current.previews.filter(
                (preview) =>
                  preview.url !== event.preview.url ||
                  preview.projectId !== event.preview.projectId ||
                  (preview.vmBotId ?? null) !== (event.preview.vmBotId ?? null),
              ),
              event.preview,
            ],
          }
        if (event.type === "import.progress")
          return { ...current, importProgress: { phase: event.phase, done: event.done, total: event.total } }
        if (event.type === "notification.created" || event.type === "notification.resolved")
          return Object.assign({}, current, {
            notifications: getReadNotifications(
              upsertNotification(current.notifications, event.notification),
              current.notificationReads,
            ),
          })
        if (event.type === "notifications.read") {
          if (event.personId !== personId) return current
          // Receipts can arrive while the initial snapshot is still in flight.
          const notificationReads = getNotificationReads(current.notificationReads ?? [], event.receipts)
          const notifications = getReadNotifications(current.notifications, notificationReads)

          return Object.assign({}, current, { notifications, notificationReads })
        }
        // The browser card confirms control; older hosts also echo the person's takeover here.
        if (
          event.type === "notify" &&
          event.title === "Browser takeover" &&
          event.body.startsWith("The user took over the browser:")
        )
          return current
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
      }
      // Only the open transcript needs interruptible rendering. Background patches share the
      // terminal update priority so obsolete events are not retained and replayed after completion.
      // Recovery snapshots must not overtake buffered patches from an in-flight history read.
      const livePatch = event.type === "message.delta" || event.type === "message.parts"
      if (
        livePatch &&
        event.threadId === currentData.current.selectedThreadId &&
        !threadLoads.current.has(event.threadId)
      ) {
        startTransition(() => setData(updateWorkspace))
        return
      }
      setData(updateWorkspace)
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
            const notifications = getReadNotifications(
              current.notifications.reduce(upsertNotification, snapshot.notifications),
              current.notificationReads,
            )
            const messages = reconcileApprovalMessages([...activity.messages, ...current.messages], notifications)
            return {
              ...current,
              notifications,
              messages: reconcileApprovalMessages(current.messages, notifications, activity.messages),
              activityMessages: current.activityMessages.reduce(updateMessage, activity.messages.map(activityMessage)),
              pendingRequestsOnReturn: countPendingRequests(notifications, messages),
              browserRuns: activity.browserRuns ?? [],
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
    const hasFailedHistory = (): boolean => {
      const failure = currentData.current.historyFailure
      return Boolean(failure && failure.kind !== "deleted" && failure.threadId === currentData.current.selectedThreadId)
    }
    const refreshOnReturn = (): void => {
      // Cursor-aware transports reconnect on return and replay changes without refetching valid history.
      if (api.cursorReady && !currentData.current.notice && !hasFailedHistory()) return
      refreshAttention()
    }
    let wasHidden = document.visibilityState === "hidden"
    const visibility = (): void => {
      if (document.visibilityState === "hidden") wasHidden = true
      else if (wasHidden) {
        wasHidden = false
        refreshOnReturn()
      }
    }
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("online", refreshOnReturn)
    const unsubscribeConnection = api.subscribeConnection?.((connected) => {
      if (!connected) return
      if (snapshotUnavailable.current || !currentData.current.loaded) {
        resync()
        return
      }
      if (currentData.current.notice || hasFailedHistory()) refreshAttention()
    })
    // Subscribe first, then load: the snapshot starts where live delivery does.
    void (api.cursorReady?.() ?? Promise.resolve()).then(() => {
      if (active) void load()
    })
    return () => {
      active = false
      generation.current += 1
      historyCache.current.clear()
      messageRepairs.current.clear()
      unloadedStreams.current.clear()
      prefetchedThreads.current.forEach(({ controller }) => {
        controller.abort()
      })
      prefetchedThreads.current.clear()
      olderHistoryLoad.current?.controller.abort()
      olderHistoryLoad.current = null
      // Pending callbacks share these request-owned arrays, so clear them before abandoning the loads.
      for (const load of threadLoads.current.values()) {
        load.controller.abort()
        load.deltas.length = 0
        load.deferredDeltas.length = 0
      }
      threadLoads.current.clear()
      loadedThreads.current.clear()
      liveRuns.current.clear()
      runNotice.current = null
      completedDuringLoad.current = null
      unsubscribe()
      unsubscribeConnection?.()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("online", refreshOnReturn)
    }
  }, [api, enabled, load, loadThread, removeGroup, personId, recordUnloadedStream])

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
    if (olderHistoryLoad.current && olderHistoryLoad.current.threadId !== data.selectedThreadId) {
      olderHistoryLoad.current.controller.abort()
      olderHistoryLoad.current = null
    }
    for (const [key, repair] of messageRepairs.current)
      if (repair.threadId !== data.selectedThreadId) messageRepairs.current.delete(key)
    for (const id of loadedThreads.current.keys()) if (id !== data.selectedThreadId) loadedThreads.current.delete(id)
    for (const [id, load] of threadLoads.current) {
      if (id === data.selectedThreadId) continue
      // Clearing the request-owned buffer in place releases payloads still captured by its callback.
      load.controller.abort()
      load.deltas.length = 0
      threadLoads.current.delete(id)
    }
    const channelReady = data.threads.some(
      (thread) =>
        thread.id === data.selectedThreadId &&
        thread.groupId &&
        (data.groupsLoaded || data.readyGroupIds?.includes(thread.groupId)),
    )
    if (enabled && (!data.loading || channelReady) && data.selectedThreadId && !data.threadCreation) {
      const focus = data.messageFocus?.threadId === data.selectedThreadId ? data.messageFocus : null
      const missingFocus =
        focus &&
        data.historyFocusId !== focus.messageId &&
        !data.messages.some((message) => message.id === focus.messageId)
      const focusedWindowClosed = !focus && Boolean(data.historyFocusId)
      const thread = data.threads.find((thread) => thread.id === data.selectedThreadId)
      const missingBranch =
        !focus &&
        !thread?.groupId &&
        thread?.activeLeafId &&
        loadedThreads.current.get(thread.id) === generation.current &&
        !data.messages.some((message) => message.id === thread.activeLeafId)
      void loadThread(data.selectedThreadId, Boolean(missingFocus || focusedWindowClosed || missingBranch))
    }
  }, [
    enabled,
    data.loading,
    data.groupsLoaded,
    data.readyGroupIds,
    data.threads,
    data.selectedThreadId,
    data.messageFocus,
    data.threadCreation,
    projectRevision,
    loadThread,
  ])

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
        const draftThread = current.loaded ? getDraftThread(botId) : null
        const composerKey = draftThread ? crypto.randomUUID() : null
        return {
          ...current,
          selectedBotId: botId,
          threadCreation: draftThread ? { thread: draftThread, status: "draft" } : null,
          composerKey,
          selectedThreadId: draftThread?.id ?? null,
          activeProjectId: bot?.projectId ?? null,
          processes: getProcessesForBot(current, bot),
        }
      }
      return {
        ...current,
        selectedBotId: botId,
        threadCreation: null,
        composerKey: null,
        selectedThreadId: thread.id,
        activeProjectId: bot?.projectId ?? null,
        processes: getProcessesForBot(current, bot),
      }
    })
  }, [])

  const selectThread = useCallback(
    (
      threadId: Id,
      options?: { readRoutineGroup?: boolean; messageId?: Id | undefined; approvalId?: Id | undefined },
    ): void => {
      setData((current) => {
        const approvalMessage = options?.approvalId
          ? [...current.messages, ...current.activityMessages].find(
              (message) =>
                message.threadId === threadId &&
                message.parts.some((part) => part.type === "approval" && part.approvalId === options.approvalId),
            )
          : undefined
        const messageId = options?.messageId ?? approvalMessage?.id
        const isMessageLoaded = Boolean(
          messageId && current.messages.some((message) => message.id === messageId && message.threadId === threadId),
        )
        const replaceHistory = (messageId && !isMessageLoaded) || (!messageId && current.historyFocusId)
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
          messages: replaceHistory ? [] : current.messages,
          historyThreadId: replaceHistory ? null : (current.historyThreadId ?? null),
          historyFocusId: messageId && isMessageLoaded ? messageId : (current.historyFocusId ?? null),
          messageFocus: messageId
            ? {
                threadId,
                messageId,
                request: (current.messageFocus?.request ?? 0) + 1,
                ...(options?.approvalId ? { approvalId: options.approvalId } : {}),
              }
            : null,
          threadCreation: null,
          composerKey: null,
          threads: current.threads.map((thread) => (readIds.has(thread.id) ? { ...thread, unread: 0 } : thread)),
        }
      })
    },
    [],
  )

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
          historyThreadId: response.thread.id,
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
      const draftThread = data.threadCreation?.thread ?? getDraftThread(selectedBot.id, groupId)
      const composerKey = data.threadCreation ? data.composerKey : crypto.randomUUID()
      // A paused bot keeps the draft; the effect below requests the thread once it resumes.
      if (selectedBot.paused && !draftThread.groupId) {
        setData((current) => ({
          ...current,
          selectedThreadId: draftThread.id,
          threadCreation: { thread: draftThread, status: "draft" },
          composerKey,
        }))
        return
      }
      creatingThread.current = true
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
            ? {
                selectedThreadId: response.thread.id,
                historyThreadId: response.thread.id,
                selectedBotId: response.thread.botId,
                threadCreation: null,
              }
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
        settleThreadCreation()
      }
    },
    [api, selectedBot, data.threadCreation, data.composerKey],
  )
  // A bot picked without threads opens a draft; request the real thread once the bot can answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a settled creation must retry a draft that waited on it
  useEffect(() => {
    const draft = data.threadCreation
    if (!enabled || !data.loaded || !chatOpen || role === null) return
    if (draft?.status !== "draft" || selectedBot?.id !== draft.thread.botId || selectedBot.paused) return
    void startThread(draft.thread.groupId ?? undefined)
  }, [
    enabled,
    data.loaded,
    chatOpen,
    role,
    data.threadCreation,
    selectedBot?.id,
    selectedBot?.paused,
    startThread,
    threadCreationSettled,
  ])
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
      if (currentData.current.messageFocus) selectThread(selectedThread.id)
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
      setData((current) => {
        const replyId = response.run?.replyMessageId
        const activeLeafId =
          replyId && current.messages.some((message) => message.id === replyId) ? replyId : response.message.id
        return {
          ...current,
          messages: updateMessage(current.messages, response.message),
          threads: current.threads.map((thread) =>
            thread.id === selectedThread.id ? { ...thread, activeLeafId } : thread,
          ),
          runs: response.run ? mergeRunRows(current.runs, [response.run]) : current.runs,
        }
      })
    },
    [api, selectedThread, data.threadCreation, selectThread],
  )

  const retryRun = useCallback(
    async (runId: Id): Promise<void> => {
      const response = await api.request("POST /runs/:id/retry", {}, { id: runId })
      setData((current) => ({ ...current, runs: mergeRunRows(current.runs, [response.run]) }))
    },
    [api],
  )

  const cancelRun = useCallback(
    async (runId: Id, scope?: "group" | "turn"): Promise<void> => {
      const response = await api.request("POST /runs/:id/cancel", scope ? { scope } : {}, { id: runId })
      if (!activeRun(response.run)) {
        const revision = ++runRevision.current
        liveRuns.current.delete(response.run.id)
        completedDuringLoad.current?.add(response.run.id)
        const load = threadLoads.current.get(response.run.threadId)
        if (load) load.terminalRevision = revision
      }
      setData((current) =>
        Object.assign({}, current, {
          runs: mergeRunRows(current.runs, [response.run]),
          workRuns: current.workRuns.filter((run) => run.id !== response.run.id || activeRun(response.run)),
        }),
      )
    },
    [api],
  )

  const switchBranch = useCallback(
    async (threadId: Id, leafId: Id): Promise<void> => {
      const response = await api.request("PATCH /threads/:id", { activeLeafId: leafId }, { id: threadId })
      setData((current) => {
        const updated = getWorkspaceWithUpdatedThread(current, response.thread)
        if (current.historyFocusId && current.messageFocus?.messageId !== leafId)
          return {
            ...updated,
            messages: [],
            historyThreadId: null,
            messageFocus: { threadId, messageId: leafId, request: (current.messageFocus?.request ?? 0) + 1 },
          }
        return current.messages.some((message) => message.id === leafId)
          ? updated
          : { ...updated, historyThreadId: null }
      })
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

  const updateBotModel = useCallback(
    async (botId: Id, model: string | null): Promise<void> => {
      const previousModel = currentData.current.bots.find((bot) => bot.id === botId)?.model
      if (previousModel === undefined) return

      setData((current) => ({
        ...current,
        bots: current.bots.map((bot) => (bot.id === botId ? { ...bot, model } : bot)),
      }))
      try {
        const response = await api.request("PATCH /bots/:id", { model }, { id: botId })
        setData((current) => ({ ...current, bots: uniqueById([...current.bots, response.bot]) }))
      } catch (error) {
        setData((current) => ({
          ...current,
          bots: current.bots.map((bot) =>
            bot.id === botId && bot.model === model ? { ...bot, model: previousModel } : bot,
          ),
        }))
        throw error
      }
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
      const vmBotId = getProcessVmBotId(bot)
      await api.request("PUT /projects/:id/processes/:name", { ...input, vmBotId }, { id: projectId, name })
      if (!isProcessScopeCurrent(currentData.current, projectId, vmBotId)) return

      await loadProject(projectId, vmBotId ?? undefined)
    },
    [api, data.bots, data.selectedBotId, loadProject],
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
      const draftThread = !target && !fallback && current.loaded ? getDraftThread(botId) : null
      return {
        ...current,
        selectedBotId: botId,
        threadCreation: draftThread ? { thread: draftThread, status: "draft" } : null,
        composerKey: draftThread ? crypto.randomUUID() : null,
        activeProjectId: current.bots.find((candidate) => candidate.id === botId)?.projectId ?? null,
        processes: [],
        selectedThreadId: target?.id ?? fallback?.id ?? draftThread?.id ?? null,
        threads: current.threads.map((candidate) =>
          candidate.id === target?.id ? { ...candidate, unread: 0 } : candidate,
        ),
      }
    })
  }, [])

  const dismissAllNotifications = useCallback(
    async (ids: number[]) => {
      return clearNotifications(api, ids, currentData.current.notifications, (notifications) => {
        setData((current) =>
          Object.assign({}, current, {
            notifications: notifications.reduce(upsertNotification, current.notifications),
          }),
        )
      })
    },
    [api],
  )

  const dismissNotification = useCallback(
    async (id: number): Promise<void> => {
      const notification = currentData.current.notifications.find((item) => item.id === id)
      if (notification && canMarkNotificationRead(notification)) {
        await dismissAllNotifications([id])
        return
      }

      const response = await api.request("POST /notifications/:id/dismiss", {}, { id: String(id) })
      setData((current) => ({
        ...current,
        notifications: upsertNotification(current.notifications, response.notification),
      }))
    },
    [api, dismissAllNotifications],
  )

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
    // The selected transcript stays complete; sidebar and avatar readers need only current activity.
    return getRetainedActivity(reconcileApprovalMessages([...rows.values()], data.notifications), data.runs)
  }, [data.activityMessages, data.messages, data.notifications, data.runs])

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
      loadOlderMessages,
      prefetchThread,
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
      updateBotModel,
      deleteBot: async (botId, name, deleteVolumes) => {
        try {
          await api.request("DELETE /bots/:id", { name, deleteVolumes }, { id: botId })
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "TOURI-E2015") throw error

          const notice = t(
            "O bot foi excluído, mas a limpeza dos anexos privados está pendente. O touri tentará concluir a limpeza automaticamente.",
            {},
            getDocumentLocale(document.documentElement),
          )
          setData((current) => ({
            ...withoutBot(current, botId),
            notice,
          }))
          return
        }

        const notice = t(
          "O bot foi removido. A limpeza do histórico e dos anexos continua em segundo plano.",
          {},
          getDocumentLocale(document.documentElement),
        )
        setData((current) => ({ ...withoutBot(current, botId), notice }))
      },
      archiveThread: async (threadId, archived) => {
        const response = await api.request("PATCH /threads/:id", { archived }, { id: threadId })
        setData((current) => getWorkspaceWithUpdatedThread(current, response.thread))
        return response.thread
      },
      archiveThreads: async (threadIds, archived) => {
        for (const threadId of threadIds) {
          const response = await api.request("PATCH /threads/:id", { archived }, { id: threadId })
          setData((current) => getWorkspaceWithUpdatedThread(current, response.thread))
        }
      },
      deleteThread: async (threadId, botId) => {
        await api.request("DELETE /threads/:id", {}, { id: threadId })
        setData((current) => getWorkspaceWithoutThread(current, threadId, botId))
      },
      deleteThreads: async (threadIds, botId) => {
        const batches = Array.from({ length: Math.ceil(threadIds.length / 200) }, (_, index) =>
          threadIds.slice(index * 200, (index + 1) * 200),
        )
        for (const ids of batches) {
          await api.request("POST /threads/delete", { ids })
          setData((current) => getWorkspaceWithoutThreads(current, new Set(ids), botId))
        }
      },
      getThreadDeletePreview: (threadId) => api.request("GET /threads/:id/delete-preview", {}, { id: threadId }),
      loadArchivedThreads: async (botId, before) => {
        const response = await api.request(
          "GET /bots/:id/threads",
          { archived: true, ...(before ? { before } : {}) },
          { id: botId },
        )
        return response.threads
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

// Members can load their channels while owner-only resources remain forbidden.
const getOptionalWorkspaceRead = async <Value, Fallback>(
  request: Promise<Value>,
  forbidden: Fallback,
): Promise<Value | Fallback> => {
  try {
    return await request
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error
    return forbidden
  }
}

const getHistoryEventThreadId = (event: UiEvent): string | null => {
  if (event.type === "message.created" || event.type === "message.updated") return event.message.threadId
  if ("threadId" in event && typeof event.threadId === "string") return event.threadId
  if (event.type === "run.updated") return event.run.threadId
  if (event.type === "thread.updated") return event.thread.id

  return null
}

const getMergedHistoryMessages = (snapshot: Message[], current: Message[]): Message[] => {
  const currentById = new Map(current.map((message) => [message.id, message]))
  const snapshotIds = new Set(snapshot.map((message) => message.id))
  const restored = snapshot.map((message) => {
    const previous = currentById.get(message.id)
    return updateMessage(previous ? [previous] : [], message)[0] ?? message
  })
  const merged = restored.concat(current.filter((message) => !snapshotIds.has(message.id)))
  // Sort only this fresh local array; stable time ordering preserves the server's insertion order for ties.
  return merged.sort((left, right) => left.createdAt - right.createdAt)
}

const getHistoryMessageKey = (threadId: Id, messageId: Id): string => JSON.stringify([threadId, messageId])

const isUnloadedHistoryMessage = (data: WorkspaceData, message: Message | undefined): boolean => {
  if (
    !message ||
    message.threadId !== data.selectedThreadId ||
    !data.historyBefore ||
    data.historyThreadId !== message.threadId
  )
    return false
  const first = data.messages[0]
  if (!first || data.messages.some((row) => row.id === message.id)) return false
  if (message.createdAt < first.createdAt) return true

  return (
    message.createdAt === first.createdAt &&
    message.seq !== undefined &&
    first.seq !== undefined &&
    message.seq < first.seq
  )
}

const getMergedHistoryContext = (
  previous: MessageHistoryContext | undefined,
  next: MessageHistoryContext | undefined,
): MessageHistoryContext | undefined => {
  if (!next) return previous
  const siblings = Array.from(
    new Map([...(previous?.siblings ?? []), ...next.siblings].map((message) => [message.id, message])).values(),
  )
  return { ...next, siblings }
}
