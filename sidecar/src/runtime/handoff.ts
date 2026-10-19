import type { Kernel, Message, MessagePart, Thread } from "@touri/contracts"
import { bounded } from "./utils"

const partSummary = (part: MessagePart): string => {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "command") return `command: ${part.command} (${part.resolution ?? part.exitCode ?? "running"})`
  if (part.type === "file_change") return `file change: ${part.paths.join(", ")} (${part.resolution ?? "unknown"})`
  if (part.type === "tool_call")
    return `tool: ${part.tool} → ${part.resolution ?? (part.ok === null ? "running" : part.ok ? "succeeded" : "failed")}`
  if (part.type === "approval") return `approval: ${part.request} (${part.decision})`
  if (part.type === "notice") return `notice: ${part.text}`
  return `attachment: ${part.type}`
}

const messageText = (message: Message): string => {
  const parts = message.parts
    .filter(
      (part) => !message.text || (part.type !== "text" && !(part.type === "notice" && part.text === message.text)),
    )
    .map(partSummary)
    .filter((part) => part.length > 0)
  return [message.text, ...parts].filter(Boolean).join("; ")
}

const messageLabel = (message: Message): string =>
  message.parts.some((part) => part.type === "notice" && part.code === "group_coordination_prompt")
    ? "group request"
    : message.role

export const buildHandoffPacket = ({
  kernel,
  thread,
  reason,
}: {
  kernel: Kernel
  thread: Thread
  reason: string
}): string => {
  const store = kernel.services.use("store.api")
  if (!store)
    return `[touri handoff]\nSession replaced: ${reason}\nFooter: Use history_search/history_read for anything older.`
  const messages = store.activePath({ threadId: thread.id, limit: 40 })
  const recent: Array<string> = []
  let recentCharacters = 0
  for (let index = messages.length - 1; index >= 0 && recentCharacters < 24_000; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const line = `${messageLabel(message)}: ${bounded({ value: messageText(message), max: 6_000 })}`
    recent.unshift(line)
    recentCharacters += line.length
  }
  const recentMessages = recent.length === 0 ? [] : messages.slice(-recent.length)
  const recentIds = new Set(recentMessages.map((message) => message.id))
  const older = store
    .activePath({ threadId: thread.id, limit: 24, fromRoot: true })
    .filter((message) => !recentIds.has(message.id))
    .map((message) => `${messageLabel(message)}: ${messageText(message).slice(0, 200)}`)
    .join("\n")
  const projectInfo = thread.botId ? kernel.services.use("projects.info") : null
  const environment = projectInfo
    ? "Project environment available through project_info."
    : "Project environment unavailable."
  const packet = [
    `[touri handoff]`,
    `Session replaced: ${reason}`,
    `Thread: ${thread.title}`,
    "Recent messages:",
    recent.join("\n"),
    "Older excerpts:",
    bounded({ value: older, max: 4_000 }),
    "Recent work:",
    recent
      .flatMap((line) => (line.includes("tool:") ? [line] : []))
      .slice(-20)
      .join("\n"),
    `Environment: ${environment}`,
    "Footer: Use history_search/history_read for anything older.",
  ].join("\n")
  return bounded({ value: packet, max: 32_000 })
}
