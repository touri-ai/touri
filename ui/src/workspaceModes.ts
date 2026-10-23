import type { Thread } from "@touri/contracts"

export type WorkspaceMode = "bots" | "work"

export type ModeSelection = { botId: string; threadId: string | null }

export const getModeSelection = (
  mode: WorkspaceMode,
  threads: readonly Thread[],
  bots: readonly { id: string }[],
  remembered: ModeSelection | undefined,
): ModeSelection | undefined => {
  if (remembered && remembered.threadId === null && bots.some((bot) => bot.id === remembered.botId)) return remembered
  const thread = getModeThread(mode, threads, remembered?.threadId ?? undefined)
  return thread ? { botId: thread.botId, threadId: thread.id } : undefined
}

/** A deleted or archived destination falls back within the requested mode. */
export const getModeThread = (
  mode: WorkspaceMode,
  threads: readonly Thread[],
  rememberedId: string | undefined,
): Thread | undefined => {
  const available = threads.filter((thread) => !thread.archivedAt)
  const remembered = available.find((thread) => thread.id === rememberedId)
  if (remembered && (mode === "work" || (!remembered.groupId && !remembered.groupThreadId))) return remembered
  if (mode === "bots")
    return available.find((thread) => !thread.groupId && !thread.groupThreadId && thread.kind !== "routine")

  return (
    available.find((thread) => thread.groupId) ??
    available.find((thread) => !thread.groupThreadId && thread.kind !== "routine")
  )
}
