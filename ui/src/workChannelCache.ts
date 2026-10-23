import type { BotGroup, Thread } from "@touri/contracts"
import { validAvatarShape } from "@touri/contracts/avatar"
import { getStorageScope, scopedStorageKey } from "./storageScope"

// localStorage strings use UTF-16 code units: 32K characters cap the snapshot at 64 KiB.
const maxChars = 32 * 1024
const maxAge = 7 * 24 * 60 * 60 * 1000
type ChannelSnapshot = { groups: BotGroup[]; threads: Thread[]; selectedThreadId: string | null }
type CachedThread = Pick<Thread, "id" | "botId" | "groupId" | "title" | "kind" | "createdAt" | "updatedAt" | "unread">

export const getWorkChannelCache = (personId: string, now = Date.now()): ChannelSnapshot | null => {
  try {
    const raw = localStorage.getItem(getKey(personId))
    if (!raw || raw.length > maxChars) return null
    const snapshot = JSON.parse(raw) as { at: number } & ChannelSnapshot
    if (!Number.isFinite(snapshot.at) || snapshot.at > now || now - snapshot.at > maxAge) return null
    if (!Array.isArray(snapshot.groups) || snapshot.groups.length > 200) return null
    if (!Array.isArray(snapshot.threads) || snapshot.threads.length > 500) return null
    if (!snapshot.groups.every(isGroup) || !snapshot.threads.every(isThread)) return null
    const groupIds = new Set(snapshot.groups.map((group) => group.id))
    const threads = snapshot.threads.filter((thread) => thread.groupId && groupIds.has(thread.groupId))

    return {
      groups: snapshot.groups,
      threads: threads.map(getCachedThread),
      selectedThreadId: threads.some((thread) => thread.id === snapshot.selectedThreadId)
        ? snapshot.selectedThreadId
        : null,
    }
  } catch {
    return null
  }
}

export const saveWorkChannelCache = (
  snapshot: ChannelSnapshot,
  personId: string,
  now = Date.now(),
  scope = getStorageScope(),
): void => {
  try {
    const groups = snapshot.groups.slice(0, 200)
    const groupIds = new Set(groups.map((group) => group.id))
    const threads = snapshot.threads
      .filter((thread) => thread.groupId && groupIds.has(thread.groupId) && !thread.groupThreadId && !thread.archivedAt)
      .slice(0, 500)
      .map(getThreadSummary)
    const value = JSON.stringify({ at: now, groups, threads, selectedThreadId: snapshot.selectedThreadId })
    if (value.length > maxChars) return

    localStorage.setItem(getKey(personId, scope), value)
  } catch {
    // Storage limits must never prevent Work from opening.
  }
}

const getKey = (personId: string, scope = getStorageScope()): string =>
  scopedStorageKey(`touri.work-channels.v1:${encodeURIComponent(personId)}`, scope)

// Only sidebar metadata is persisted; prose, tool output, paths and approval state stay on the server.
const getThreadSummary = (thread: CachedThread): CachedThread => ({
  id: thread.id,
  botId: thread.botId,
  groupId: thread.groupId ?? null,
  title: thread.title,
  kind: thread.kind,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  unread: thread.unread,
})

const getCachedThread = (thread: CachedThread): Thread => ({
  ...getThreadSummary(thread),
  parentThreadId: null,
  activeLeafId: null,
  routineRunId: null,
  cwdOverride: null,
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
  archivedAt: null,
})

const isGroup = (group: BotGroup): boolean =>
  !!group &&
  typeof group.id === "string" &&
  typeof group.name === "string" &&
  typeof group.color === "string" &&
  typeof group.avatarSeed === "string" &&
  validAvatarShape(group.avatarShape) &&
  Array.isArray(group.memberIds) &&
  group.memberIds.every((id) => typeof id === "string") &&
  (group.coordinatorBotId === null || typeof group.coordinatorBotId === "string") &&
  Number.isFinite(group.createdAt) &&
  Number.isFinite(group.updatedAt)

const isThread = (thread: CachedThread): boolean =>
  !!thread &&
  typeof thread.id === "string" &&
  typeof thread.botId === "string" &&
  typeof thread.groupId === "string" &&
  typeof thread.title === "string" &&
  ["main", "chat", "routine"].includes(thread.kind) &&
  Number.isFinite(thread.createdAt) &&
  Number.isFinite(thread.updatedAt) &&
  Number.isFinite(thread.unread)
