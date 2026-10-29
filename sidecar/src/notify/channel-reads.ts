import type { Database } from "bun:sqlite"
import type { ChannelPerson, ChannelReadState, Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import { getMentionedPeople } from "../groups/people"
import type { DevicePerson } from "../kernel/device-session"
import { getNotificationReader } from "./routes"

/** Counts stop here; the sidebar shows 99+ long before. */
const MAX_UNREAD = 1000
/** Mentions are looked for in the newest unread replies only, and in a bounded prefix of each. */
const MAX_MENTION_CANDIDATES = 100
const MAX_MENTION_TEXT = 8000
/**
 * A channel copy settles around its member run's finish. The index seek on the copy's update time
 * starts this much before the read position; the run's finish time then decides exactly.
 */
const SETTLE_WINDOW_MS = 60_000

type Reader = Pick<DevicePerson, "id" | "role">
type ChannelThread = { id: string; group_id: string }
type MentionCandidate = {
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

// The final reply of a succeeded member run, as copied into the channel. Seeks
// messages_assistant_complete from the read position; joins use primary keys and
// group_message_links_message. Later edits of the copy never move the run's finish time.
const UNREAD_FROM = `FROM messages visible
    JOIN runs member ON member.id = visible.run_id
    JOIN group_message_links shared ON shared.message_id = member.reply_message_id AND shared.visible_message_id = visible.id`
const UNREAD_WHERE = `WHERE visible.thread_id = ? AND visible.role = 'assistant' AND visible.status = 'complete'
      AND visible.updated_at > ? AND member.status = 'succeeded' AND member.finished_at > ?`

/** Unread final replies in one channel conversation: thread, seek start, read position. */
export const CHANNEL_UNREAD_COUNT_SQL = `SELECT COUNT(*) AS n FROM (SELECT 1 ${UNREAD_FROM} ${UNREAD_WHERE} LIMIT ${MAX_UNREAD})`

/**
 * Per-person read positions for channel conversations. A final bot reply is the channel copy of a
 * member run's reply, finished after the person last read the channel.
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
  const getUnreadCount = (threadId: string, readAt: number): number =>
    (database.query(CHANNEL_UNREAD_COUNT_SQL).get(threadId, readAt - SETTLE_WINDOW_MS, readAt) as { n: number }).n
  const getMentionCandidates = (threadId: string, readAt: number): MentionCandidate[] =>
    database
      .query(`SELECT substr(visible.text, 1, ${MAX_MENTION_TEXT}) AS text, turn.requester_person_id AS requester,
          link.depth AS depth, turn.trigger AS trigger,
          request.id IS NOT NULL AND request.sender_json IS NULL AS localRequest
        ${UNREAD_FROM}
        LEFT JOIN group_run_links link ON link.run_id = member.id
        LEFT JOIN runs turn ON turn.id = link.turn_id
        LEFT JOIN messages request ON request.thread_id = turn.thread_id AND request.id = turn.request_message_id
        ${UNREAD_WHERE}
        ORDER BY visible.updated_at DESC LIMIT ${MAX_MENTION_CANDIDATES}`)
      .all(threadId, readAt - SETTLE_WINDOW_MS, readAt) as MentionCandidate[]

  /** One person's state; channel people are looked up once per channel and only when replies are unread. */
  const getState = (
    reader: Reader,
    thread: ChannelThread,
    getPerson: (groupId: string) => ChannelPerson | undefined,
  ): ChannelReadState => {
    const readAt = getReadAt(reader.id, thread.id)
    const unread = getUnreadCount(thread.id, readAt)
    if (unread === 0) return { threadId: thread.id, readAt, unread, mentions: 0 }

    const person = getPerson(thread.group_id)
    // Without Work accounts the owner's own messages carry no sender; integrations always do.
    const owner = kernel.services.use("work.defaultPersonId")?.() ?? "owner"
    const getRequester = (reply: MentionCandidate): string | null =>
      reply.requester ?? (reply.trigger === "user" && reply.localRequest === 1 ? owner : null)
    const mentions = getMentionCandidates(thread.id, readAt).filter(
      (reply) =>
        (reply.depth === 0 && getRequester(reply) === reader.id) ||
        (person !== undefined && getMentionedPeople(reply.text, [person]).length > 0),
    ).length

    return { threadId: thread.id, readAt, unread, mentions }
  }
  const getPeopleLookup = (reader: Reader) => {
    const people = new Map<string, ChannelPerson | undefined>()
    return (groupId: string) => {
      if (!people.has(groupId))
        people.set(
          groupId,
          (kernel.services.use("work.channelPeople")?.(groupId) ?? []).find(({ id }) => id === reader.id),
        )
      return people.get(groupId)
    }
  }
  const canRead = (reader: Reader, threadId: string): boolean =>
    reader.role === "admin" ||
    Boolean(kernel.services.use("work.canAccessThread")?.({ personId: reader.id, role: reader.role, threadId }))

  const list = (reader: Reader): ChannelReadState[] => {
    const threads = database
      .query(
        "SELECT id, group_id FROM threads WHERE group_id IS NOT NULL AND group_thread_id IS NULL AND archived_at IS NULL",
      )
      .all() as ChannelThread[]
    // Members only see their own channels; the per-thread check runs on that subset.
    const getChannelIds = kernel.services.use("work.personChannelIds")
    const channelIds = reader.role !== "admin" && getChannelIds ? new Set(getChannelIds(reader.id)) : null
    const getPerson = getPeopleLookup(reader)

    return threads
      .filter((thread) => (channelIds?.has(thread.group_id) ?? true) && canRead(reader, thread.id))
      .map((thread) => getState(reader, thread, getPerson))
  }

  const markRead = (reader: Reader, thread: ChannelThread): ChannelReadState => {
    // A read position never moves back, so a late request cannot resurrect replies already seen.
    const readAt = Math.max(Date.now(), getReadAt(reader.id, thread.id))
    database
      .query(`INSERT INTO channel_reads(person_id, thread_id, read_at) VALUES (?, ?, ?)
        ON CONFLICT(person_id, thread_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`)
      .run(reader.id, thread.id, readAt)
    kernel.publish({ type: "channel.read", personId: reader.id, threadId: thread.id, readAt })

    return getState(reader, thread, getPeopleLookup(reader))
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
