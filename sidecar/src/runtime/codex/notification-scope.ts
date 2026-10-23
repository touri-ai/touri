import { asRecord, stringValue } from "../utils"

/** Read only protocol identity containers, never tool arguments or message content. */
export const getNotificationScope = (params: Record<string, unknown>, method?: string | null) => {
  const turn = asRecord(params.turn)
  const item = asRecord(params.item)
  const error = asRecord(params.error)
  const thread = asRecord(params.thread)
  const containers = [
    params,
    turn,
    item,
    error,
    thread,
    asRecord(item?.turn),
    asRecord(error?.turn),
    asRecord(turn?.error),
    asRecord(item?.error),
  ]
  const threadIds = containers.flatMap((container) => [
    stringValue(container?.threadId),
    stringValue(container?.thread_id),
    stringValue(asRecord(container?.thread)?.id),
  ])
  const turnIds = containers.flatMap((container) => [
    stringValue(container?.turnId),
    stringValue(container?.turn_id),
    stringValue(asRecord(container?.turn)?.id),
  ])

  return {
    threadIds: threadIds.filter((id): id is string => id !== null),
    turnIds: [...turnIds, ...(method === "turn/started" ? [stringValue(params.id)] : [])].filter(
      (id): id is string => id !== null,
    ),
  }
}

export const isNotificationForTurn = (
  scope: ReturnType<typeof getNotificationScope>,
  threadId: string,
  turnId: string | null,
): boolean =>
  scope.threadIds.every((id) => id === threadId) && scope.turnIds.every((id) => turnId === null || id === turnId)

export const getDeclinedServerRequest = (method: string) => {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")
    return { result: { decision: "decline" } }
  if (method === "item/permissions/requestApproval") return { result: { permissions: {}, scope: "turn" } }
  if (method === "mcpServer/elicitation/request") return { result: { action: "decline", content: null } }

  return { error: { code: -32601, message: "Unsupported session request" } }
}

// Legacy peers omit identities on these events. Defer them until turn/start is acknowledged.
export const isTurnNotification = (method: string | null): boolean =>
  !!method && (method.startsWith("turn/") || method.startsWith("item/") || method === "usage")
