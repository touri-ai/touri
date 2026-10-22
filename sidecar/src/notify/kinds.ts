import type { NotifyKind } from "@touri/contracts"

export const ATTENTION_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
  "mention",
  "approval",
  "question",
  "takeover",
  "routine-deferred",
  "routine-failed",
  "turn-failed",
  "incident",
])

export const MESSAGE_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
  "done",
  "delegation-settled",
  "notice",
  "task-started",
])

export const BLOCKING_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["approval", "question", "takeover"])

export const BACKLOG_WINDOW_MS = 48 * 60 * 60 * 1000
export const MESSAGE_REPLAY_MS = 60_000
export const HEARTBEAT_MS = 15_000

export const isAttentionKind = (kind: NotifyKind): boolean => ATTENTION_KINDS.has(kind)
