import type { Id, Kernel } from "@touri/contracts"
import { getDelegation } from "../groups/security"
import { isReviewThread } from "../learning/settings"

/** External personal memory is available only in direct conversations with the user. */
export const mem0SessionAllowed = (kernel: Kernel, threadId: Id): boolean => {
  const thread = kernel.services.use("store.api")?.getThread({ threadId })
  const run = kernel.services.use("runtime.activeRun")?.({ threadId })
  return (
    !!thread &&
    !thread.groupId &&
    thread.kind !== "routine" &&
    !thread.routineRunId &&
    !isReviewThread(kernel, thread.botId, threadId) &&
    !getDelegation(kernel, threadId) &&
    run?.trigger !== "routine" &&
    !run?.routineRunId
  )
}
