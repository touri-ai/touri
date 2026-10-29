import type { Database } from "bun:sqlite"
import type { ChannelReadState, Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import { getMentionedPeople } from "../groups/people"
import type { DevicePerson } from "../kernel/device-session"
import { getNotificationReader } from "./routes"

/** Counts stop here; the sidebar shows 99+ long before. */
const MAX_UNREAD = 1000

type Reader = Pick<DevicePerson, "id" | "role">
type ChannelThread = { id: string; group_id: string }
type UnreadReply = {
  text: string
  requester: string | null
  depth: number | null
  trigger: string | null
  localRequest: number | null
}

const fail = (status: number, errorCode: string, error: string): RouteResponse => ({
  status,
  json: { errorCode, error },
})

/**
 * Per-person read positions for channel conversations. A final bot reply is the channel copy of a
 * member run's reply, settled after the person last read the channel.
 */
export const createChannelReads = (kernel: Kernel) => {
  const database = kernel.db as Database
  const getSince = (): number =>
    Number(
      (
        database.query("SELECT value FROM schema_meta WHERE key = 'channel_reads_since'").get() as {
          value: string
        } | null
      )?.value ?? 0,
    )
  const getChannelThread = (threadId: string): ChannelThread | null =>
    database
      .query(
        "SELECT id, group_id FROM threads WHERE id = ? AND group_id IS NOT NULL AND group_thread_id IS NULL AND archived_at IS NULL",
      )
      .get(threadId) as ChannelThread | null
  const getReadAt = (personId: string, threadId: string): number =>
    (
      database
        .query("SELECT read_at FROM channel_reads WHERE person_id = ? AND thread_id = ?")
        .get(personId, threadId) as {
        read_at: number
      } | null
    )?.read_at ?? getSince()
  // Seeks the settled assistant replies after the read position through messages_assistant_complete.
  const unreadReplies = database.query(`SELECT visible.text AS text, turn.requester_person_id AS requester,
      link.depth AS depth, turn.trigger AS trigger, request.sender_json IS NULL AS localRequest
    FROM messages visible
    JOIN runs member ON member.id = visible.run_id
    JOIN group_message_links shared ON shared.message_id = member.reply_message_id AND shared.visible_message_id = visible.id
    LEFT JOIN group_run_links link ON link.run_id = member.id
    LEFT JOIN runs turn ON turn.id = link.turn_id
    LEFT JOIN messages request ON request.thread_id = turn.thread_id AND request.id = turn.request_message_id
    WHERE visible.thread_id = ? AND visible.role = 'assistant' AND visible.status = 'complete'
      AND visible.updated_at > ? AND member.status = 'succeeded'
    ORDER BY visible.updated_at LIMIT ${MAX_UNREAD}`)

  const getState = (reader: Reader, thread: ChannelThread): ChannelReadState => {
    const readAt = getReadAt(reader.id, thread.id)
    const replies = unreadReplies.all(thread.id, readAt) as UnreadReply[]
    const person = (kernel.services.use("work.channelPeople")?.(thread.group_id) ?? []).find(
      ({ id }) => id === reader.id,
    )
    // Without Work accounts the owner's own messages carry no sender; integrations always do.
    const owner = kernel.services.use("work.defaultPersonId")?.() ?? "owner"
    const getRequester = (reply: UnreadReply): string | null =>
      reply.requester ?? (reply.trigger === "user" && reply.localRequest === 1 ? owner : null)
    const mentions = replies.filter(
      (reply) =>
        (reply.depth === 0 && getRequester(reply) === reader.id) ||
        (person !== undefined && getMentionedPeople(reply.text, [person]).length > 0),
    ).length

    return { threadId: thread.id, readAt, unread: replies.length, mentions }
  }
  const canRead = (reader: Reader, threadId: string): boolean =>
    reader.role === "admin" ||
    Boolean(kernel.services.use("work.canAccessThread")?.({ personId: reader.id, role: reader.role, threadId }))

  const list = (reader: Reader): ChannelReadState[] =>
    (
      database
        .query(
          "SELECT id, group_id FROM threads WHERE group_id IS NOT NULL AND group_thread_id IS NULL AND archived_at IS NULL",
        )
        .all() as ChannelThread[]
    )
      .filter((thread) => canRead(reader, thread.id))
      .map((thread) => getState(reader, thread))

  const markRead = (reader: Reader, thread: ChannelThread): ChannelReadState => {
    // A read position never moves back, so a late request cannot resurrect replies already seen.
    const readAt = Math.max(Date.now(), getReadAt(reader.id, thread.id))
    database
      .query(`INSERT INTO channel_reads(person_id, thread_id, read_at) VALUES (?, ?, ?)
        ON CONFLICT(person_id, thread_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`)
      .run(reader.id, thread.id, readAt)
    kernel.publish({ type: "channel.read", personId: reader.id, threadId: thread.id, readAt })

    return getState(reader, thread)
  }

  const routes: RouteModule = {
    name: "channel-reads",
    routes: [
      {
        method: "GET",
        path: "/channel-reads",
        handler: async ({ signal }) => {
          const reader = getNotificationReader(kernel, signal)
          if (!reader) return fail(401, "UNAUTHORIZED", "Authenticated person required")

          return { status: 200, json: { channels: list(reader) } }
        },
      },
      {
        method: "POST",
        path: "/threads/:id/read",
        handler: async ({ params, signal }) => {
          const reader = getNotificationReader(kernel, signal)
          if (!reader) return fail(401, "UNAUTHORIZED", "Authenticated person required")
          const thread = getChannelThread(params.id ?? "")
          if (!thread || !canRead(reader, thread.id)) return fail(404, "NOT_FOUND", "Channel conversation not found")

          return { status: 200, json: { channel: markRead(reader, thread) } }
        },
      },
    ],
  }

  return { list, markRead, routes }
}
