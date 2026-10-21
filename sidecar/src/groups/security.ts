import type { Bot, GroupDelegation, Kernel, McpTool } from "@touri/contracts"

const ranks = { "read-only": 0, "workspace-write": 1, full: 2 }
type Access = Bot["access"]
const HOST_FROM_GUEST_ACCESS: Access = "workspace-write"

/** A guest or remote caller must never drive a local bot on the host without a per-action approval. */
const reachesHostFromGuest = (caller: Bot, target: Bot): boolean =>
  caller.machine !== "local" && target.machine === "local"

const lowestAccess = (levels: Access[]): Access =>
  levels.reduce((lowest, level) => (ranks[level] < ranks[lowest] ? level : lowest))

/** Secrets stay available only when both bots work in the same project and the caller itself may use them. */
export const delegationSecrets = ({
  caller,
  target,
  inherited = true,
}: {
  caller: Bot
  target: Bot
  inherited?: boolean
}): boolean => inherited && !!caller.projectId && caller.projectId === target.projectId
const policy = (tool: McpTool) => tool.policy ?? (tool.classification === "reads" ? "always_allow" : "needs_approval")

export const delegationCeiling = (caller: Bot, target: Bot): Bot => ({
  ...target,
  access: lowestAccess([
    caller.access,
    target.access,
    ...(reachesHostFromGuest(caller, target) ? [HOST_FROM_GUEST_ACCESS] : []),
  ]),
  approvals:
    caller.approvals === "on-request" || target.approvals === "on-request" || reachesHostFromGuest(caller, target)
      ? "on-request"
      : "never",
  browserEnabled: caller.browserEnabled && target.browserEnabled,
  computerUse: caller.computerUse && target.computerUse,
  hostComputerUse: caller.hostComputerUse && target.hostComputerUse,
  mcpServers: (target.mcpServers ?? []).flatMap((server) => {
    const peer = caller.mcpServers?.find(
      (candidate) => JSON.stringify({ ...candidate, tools: [] }) === JSON.stringify({ ...server, tools: [] }),
    )
    if (!peer) return []
    return [
      {
        ...server,
        tools: server.tools.flatMap((tool) => {
          const allowed = peer.tools.find((candidate) => candidate.name === tool.name && candidate.policy !== "blocked")
          if (!allowed || tool.policy === "blocked") return []
          return [
            {
              ...tool,
              policy:
                policy(allowed) === "needs_approval" || policy(tool) === "needs_approval"
                  ? ("needs_approval" as const)
                  : ("always_allow" as const),
            },
          ]
        }),
      },
    ]
  }),
})

export const crossesBoundary = (caller: Bot, target: Bot): boolean =>
  caller.machine !== target.machine ||
  (caller.approvals === "on-request" && target.approvals === "never") ||
  ranks[target.access] > ranks[caller.access] ||
  (!caller.browserEnabled && target.browserEnabled) ||
  (!caller.computerUse && target.computerUse) ||
  (!caller.hostComputerUse && target.hostComputerUse) ||
  caller.projectId !== target.projectId

export type Delegation = GroupDelegation
const delegations = new WeakMap<Kernel, Map<string, Delegation>>()

export const setDelegation = (kernel: Kernel, threadId: string, delegation: Delegation | null): void => {
  let registry = delegations.get(kernel)
  if (!registry) {
    registry = new Map()
    delegations.set(kernel, registry)
  }
  if (delegation) registry.set(threadId, delegation)
  else registry.delete(threadId)
}

export const getDelegation = (kernel: Kernel, threadId: string): Delegation | null =>
  delegations.get(kernel)?.get(threadId) ?? null

// Runtime/provider and MCP dispatch must both use this view, never persist it on the bot.
export const delegatedBot = (kernel: Kernel, threadId: string, bot: Bot): Bot => {
  const delegation = getDelegation(kernel, threadId)
  return delegation ? delegationCeiling(delegation.ceiling, bot) : bot
}
