import type { Kernel, ToolHandler } from "@touri/contracts"

type NotifyArgs = { title: string; body: string }

export const createNotifyUserHandler = ({
  kernel,
  getNow = Date.now,
}: {
  kernel: Kernel
  getNow?: () => number
}): ToolHandler => {
  const lastSentAt = new Map<string, number>()
  return async ({ ctx, args }) => {
    const input = args as NotifyArgs
    const now = getNow()
    const previous = lastSentAt.get(ctx.botId)
    if (previous !== undefined && now - previous < 30_000)
      return {
        success: false,
        errorCode: "RATE_LIMITED",
        error: "Notifications are limited to one every 30 seconds. Wait before trying again.",
      }

    const emit = kernel.services.use("notify.emit")
    if (!emit)
      return { success: false, errorCode: "NOT_AVAILABLE", error: "Notifications are unavailable. Try again later." }

    emit({ kind: "notice", botId: ctx.botId, threadId: ctx.threadId, title: input.title, body: input.body })
    lastSentAt.set(ctx.botId, now)
    return {
      success: true,
      content: [{ type: "text", text: "Notification saved. Alerts follow your notification preferences." }],
    }
  }
}
