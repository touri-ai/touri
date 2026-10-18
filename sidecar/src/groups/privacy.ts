import type { Kernel, Thread, ToolContext } from "@touri/contracts"

// Participant sessions persist beyond one delegation. Keep their privacy boundary even
// when no group turn is active; a stale MCP connection must not regain private history.
export const groupHistoryThread = (thread: Thread): string | null =>
  thread.groupId ? (thread.groupThreadId ?? thread.id) : null

/**
 * Routines, local and external memory, and skills are private to direct chats;
 * group sessions can neither read nor rewrite them.
 */
export const PRIVATE_BOT_TOOLS: ReadonlySet<string> = new Set([
  "goal_checkpoint",
  "routine_list",
  "routine_create",
  "routine_update",
  "mem0_search",
  "mem0_add",
  "mem0_update",
  "mem0_delete",
  "memory_write",
  "skill_create",
  "skill_patch",
  "skill_archive",
])

export const hiddenInGroupSession = (kernel: Kernel, threadId: string, toolName: string): boolean =>
  PRIVATE_BOT_TOOLS.has(toolName) && !!kernel.services.use("store.api")?.getThread({ threadId })?.groupId

export const consentToPrivateHistory = async (kernel: Kernel, ctx: ToolContext, threadId: string): Promise<boolean> => {
  const present = kernel.services.use("approvals.present")
  if (!present || ctx.signal.aborted) return false
  const result = await present({
    ctx,
    scope: { source: "mcp", tool: "group_private_history" },
    toolName: "Consultar e compartilhar histórico privado no grupo",
    input: { threadId, aviso: "O conteúdo desta conversa privada poderá ser compartilhado com os membros do grupo." },
    allowStanding: false,
    isCurrent: () =>
      !ctx.signal.aborted && kernel.services.use("store.api")?.getThread({ threadId })?.botId === ctx.botId,
  })
  return (
    result.success &&
    result.behavior === "allow" &&
    !ctx.signal.aborted &&
    kernel.services.use("store.api")?.getThread({ threadId })?.botId === ctx.botId
  )
}
