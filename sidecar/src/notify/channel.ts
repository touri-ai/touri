import type { Database } from "bun:sqlite"
import type { Kernel, Message, Run } from "@touri/contracts"
import { getMentionedPeople } from "../groups/people"

export const initChannelNotifications = (kernel: Kernel): void => {
  kernel.subscribe(({ event }) => {
    if (event.type === "message.created" || event.type === "message.updated")
      sendMentionNotifications(kernel, event.message)
    if (event.type === "run.updated") sendTaskNotification(kernel, event.run)
  })
}

const sendMentionNotifications = (kernel: Kernel, message: Message): void => {
  if (message.status !== "complete" || message.kind !== "text") return
  if (message.role !== "user" && message.role !== "assistant") return
  const store = kernel.services.use("store.api")
  const thread = store?.getThread({ threadId: message.threadId })
  if (!thread?.groupId || thread.groupThreadId) return
  const people = kernel.services.use("work.channelPeople")?.(thread.groupId) ?? []
  const authorId =
    message.role === "user" ? (message.sender?.id ?? kernel.services.use("work.defaultPersonId")?.() ?? "owner") : null
  const author = message.sender?.name ?? people.find((person) => person.id === authorId)?.handle ?? "touri"
  const channel = getChannelName(kernel, thread.groupId)
  if (!channel) return

  const botNames = (
    (kernel.db as Database)
      .query("SELECT b.id, b.name FROM group_members gm JOIN bots b ON b.id = gm.bot_id WHERE gm.group_id = ?")
      .all(thread.groupId) as Array<{ id: string; name: string }>
  ).map((bot) => ({ ...bot, id: `bot:${bot.id}` }))
  const mentioned = getMentionedPeople(message.text, [...people, ...botNames])

  mentioned
    .filter((person) => person.id !== authorId && people.some(({ id }) => id === person.id))
    .forEach((person) => {
      kernel.services.use("notify.emit")?.({
        kind: "mention",
        botId: message.role === "assistant" ? (message.sender?.id ?? thread.botId) : null,
        threadId: thread.id,
        targetPersonId: person.id,
        requestId: `mention:${message.id}:${person.id}`,
        title: `@${author} mencionou você em #${channel}`,
        body: kernel.redact(message.text).slice(0, 500),
      })
    })
}

const sendTaskNotification = (kernel: Kernel, run: Run): void => {
  if (run.groupTurnId) return
  if (run.status !== "running" || !["user", "routine"].includes(run.trigger)) return
  const store = kernel.services.use("store.api")
  const thread = store?.getThread({ threadId: run.threadId })
  if (!thread?.groupId || thread.groupThreadId) return
  const database = kernel.db as Database
  const routine = run.routineRunId
    ? (database
        .query("SELECT r.bot_id, r.name FROM routine_runs rr JOIN routines r ON r.id = rr.routine_id WHERE rr.id = ?")
        .get(run.routineRunId) as { bot_id: string; name: string } | null)
    : null
  const bot = store?.getBot({ botId: routine?.bot_id ?? run.botId })
  const channel = getChannelName(kernel, thread.groupId)
  if (!bot || !channel) return
  const owner = bot.responsiblePersonId ?? kernel.services.use("work.defaultPersonId")?.() ?? "owner"
  const people = kernel.services.use("work.channelPeople")?.(thread.groupId) ?? []
  const recipients = Array.from(
    new Set([owner, ...(run.trigger === "user" && run.requesterPersonId ? [run.requesterPersonId] : [])]),
  )
  const request = run.requestMessageId
    ? ((kernel.db as Database)
        .query("SELECT text FROM messages WHERE thread_id = ? AND id = ?")
        .get(thread.id, run.requestMessageId) as { text: string } | null)
    : null
  const title = kernel.redact(routine?.name || request?.text.trim().split("\n")[0] || thread.title).slice(0, 120)

  recipients
    .filter((id) => people.some((person) => person.id === id))
    .forEach((personId) => {
      kernel.services.use("notify.emit")?.({
        kind: "task-started",
        botId: bot.id,
        threadId: thread.id,
        targetPersonId: personId,
        requestId: `task-started:${run.id}:${personId}`,
        title: `${bot.name} começou uma tarefa em #${channel}: ${title}`,
        body: title,
      })
    })
}

const getChannelName = (kernel: Kernel, groupId: string): string | undefined =>
  ((kernel.db as Database).query("SELECT name FROM bot_groups WHERE id = ?").get(groupId) as { name: string } | null)
    ?.name
