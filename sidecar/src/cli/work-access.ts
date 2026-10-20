import type { Database } from "bun:sqlite"
import type { UiEvent } from "@touri/contracts"
import type { AuthStore } from "./auth/store"

type PersonRole = "member" | "admin"
type RouteDecision = { status: number; json: { errorCode: string; error: string } }

const denied: RouteDecision = { status: 403, json: { errorCode: "FORBIDDEN", error: "Access denied" } }
const notFound: RouteDecision = { status: 404, json: { errorCode: "NOT_FOUND", error: "Not found" } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const stringValue = (value: unknown): string => (typeof value === "string" ? value : "")

export const createWorkAccess = ({ database, authStore }: { database: Database; authStore: AuthStore }) => {
  const channelIdsFor = (personId: string): Array<string> => {
    const configured = authStore.getPersonChannelIds(personId)
    if (configured.length === 0) return []
    const placeholders = configured.map(() => "?").join(",")
    const active = new Set(
      (
        database.query(`SELECT id FROM bot_groups WHERE id IN (${placeholders})`).all(...configured) as Array<{
          id: string
        }>
      ).map(({ id }) => id),
    )
    return configured.filter((id) => active.has(id))
  }

  const canAccessGroup = ({
    personId,
    role,
    groupId,
  }: {
    personId: string
    role: PersonRole
    groupId: string
  }): boolean => {
    if (role === "admin") return true
    if (!channelIdsFor(personId).includes(groupId)) return false
    return Boolean(database.query("SELECT 1 FROM bot_groups WHERE id = ?").get(groupId))
  }

  const canAccessBot = ({ personId, role, botId }: { personId: string; role: PersonRole; botId: string }): boolean => {
    if (role === "admin") return true
    if (
      database
        .query(`SELECT 1 FROM bots WHERE id = ? AND archived_at IS NULL
          AND (responsible_person_id = ? OR (responsible_person_id IS NULL AND ? = 'owner'))`)
        .get(botId, personId, personId)
    )
      return true
    const channelIds = channelIdsFor(personId)
    if (channelIds.length === 0) return false
    return Boolean(
      database
        .query(`SELECT 1 FROM group_members gm JOIN bots b ON b.id = gm.bot_id
          WHERE b.archived_at IS NULL AND gm.bot_id = ? AND gm.group_id IN (${channelIds.map(() => "?").join(",")}) LIMIT 1`)
        .get(botId, ...channelIds),
    )
  }

  const accessibleBotIds = ({
    personId,
    channelIds,
  }: {
    personId: string
    channelIds: Array<string>
  }): Array<string> => {
    const groupAccess = channelIds.length
      ? `OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.bot_id = b.id AND gm.group_id IN (${channelIds.map(() => "?").join(",")}))`
      : ""
    return (
      database
        .query(`SELECT b.id FROM bots b WHERE b.archived_at IS NULL
          AND (b.responsible_person_id = ? OR (b.responsible_person_id IS NULL AND ? = 'owner') ${groupAccess})
          ORDER BY b.sort_order ASC, b.created_at ASC LIMIT 500`)
        .all(personId, personId, ...channelIds) as Array<{ id: string }>
    ).map(({ id }) => id)
  }

  const canAccessThread = ({
    personId,
    role,
    threadId,
  }: {
    personId: string
    role: PersonRole
    threadId: string
  }): boolean => {
    if (role === "admin") return true
    const thread = database
      .query(`SELECT t.group_id, coalesce(t.owner_person_id, 'owner') AS owner_person_id FROM threads t JOIN bots b ON b.id = t.bot_id
        WHERE t.id = ? AND t.archived_at IS NULL AND b.archived_at IS NULL`)
      .get(threadId) as { group_id: string | null; owner_person_id: string | null } | null
    if (!thread) return false
    if (thread.group_id) return canAccessGroup({ personId, role, groupId: thread.group_id })
    return thread.owner_person_id === personId
  }

  const ownsPrivateThread = ({ personId, threadId }: { personId: string; threadId: string }): boolean =>
    Boolean(
      database
        .query(`SELECT 1 FROM threads WHERE id = ? AND group_id IS NULL AND archived_at IS NULL
          AND (owner_person_id = ? OR (owner_person_id IS NULL AND ? = 'owner'))`)
        .get(threadId, personId, personId),
    )

  const ownsBot = ({ personId, botId }: { personId: string; botId: string }): boolean =>
    Boolean(
      database
        .query(`SELECT 1 FROM bots WHERE id = ? AND archived_at IS NULL
          AND (responsible_person_id = ? OR (responsible_person_id IS NULL AND ? = 'owner'))`)
        .get(botId, personId, personId),
    )

  const canAccessAttachments = ({
    personId,
    role,
    attachmentIds,
  }: {
    personId: string
    role: PersonRole
    attachmentIds: Array<string>
  }): boolean => {
    if (role === "admin") return true
    if (attachmentIds.length > 50 || new Set(attachmentIds).size !== attachmentIds.length) return false
    if (attachmentIds.length === 0) return true
    const channelIds = channelIdsFor(personId)
    const channelScope = channelIds.length ? `t.group_id IN (${channelIds.map(() => "?").join(",")}) OR ` : ""
    const placeholders = attachmentIds.map(() => "?").join(",")
    const accessible = database
      .query(`SELECT a.id FROM attachments a WHERE a.id IN (${placeholders}) AND (a.owner_person_id = ?
        OR EXISTS (SELECT 1 FROM attachment_people p WHERE p.attachment_id = a.id AND p.person_id = ?))
        UNION
        SELECT refs.attachment_id AS id FROM attachment_message_refs refs
        JOIN threads t ON t.id = refs.thread_id JOIN bots b ON b.id = t.bot_id
        WHERE t.archived_at IS NULL AND b.archived_at IS NULL
          AND refs.attachment_id IN (${placeholders})
          AND (${channelScope}(t.group_id IS NULL AND
            (t.owner_person_id = ? OR (t.owner_person_id IS NULL AND ? = 'owner'))))`)
      .all(...attachmentIds, personId, personId, ...attachmentIds, ...channelIds, personId, personId) as Array<{
      id: string
    }>
    return accessible.length === attachmentIds.length
  }

  const canAccessAttachment = ({
    personId,
    role,
    attachmentId,
  }: {
    personId: string
    role: PersonRole
    attachmentId: string
  }): boolean => canAccessAttachments({ personId, role, attachmentIds: [attachmentId] })

  const canApprove = ({ personId, approvalId }: { personId: string; approvalId: string }): boolean => {
    const owner = database
      .query(`SELECT coalesce(b.responsible_person_id, 'owner') AS responsible_person_id FROM workspace_message_attention a
        JOIN threads t ON t.id = a.thread_id JOIN bots b ON b.id = t.bot_id
        WHERE a.approval_id = ? AND a.type = 'approval' AND a.decision = 'pending' LIMIT 1`)
      .get(approvalId) as { responsible_person_id: string | null } | null
    return owner?.responsible_person_id === personId
  }

  const canAccessRun = ({ personId, role, runId }: { personId: string; role: PersonRole; runId: string }): boolean => {
    const row = database
      .query(`SELECT coalesce(root.thread_id, r.thread_id) AS thread_id FROM runs r
        LEFT JOIN group_run_links link ON link.run_id = r.id
        LEFT JOIN runs root ON root.id = link.turn_id WHERE r.id = ? LIMIT 1`)
      .get(runId) as { thread_id: string | null } | null
    return Boolean(row?.thread_id && canAccessThread({ personId, role, threadId: row.thread_id }))
  }

  const accessibleRunIds = ({
    personId,
    channelIds,
    runIds,
  }: {
    personId: string
    channelIds: Array<string>
    runIds: Array<string>
  }): Array<string> => {
    if (runIds.length === 0 || runIds.length > 500) return []
    const placeholders = runIds.map(() => "?").join(",")
    const groupScope = channelIds.length ? `t.group_id IN (${channelIds.map(() => "?").join(",")}) OR ` : ""
    const rows = database
      .query(`SELECT r.id FROM runs r
        LEFT JOIN group_run_links link ON link.run_id = r.id
        LEFT JOIN runs root ON root.id = link.turn_id
        JOIN threads t ON t.id = coalesce(root.thread_id, r.thread_id)
        JOIN bots b ON b.id = t.bot_id
        WHERE r.id IN (${placeholders}) AND t.archived_at IS NULL AND b.archived_at IS NULL
          AND (${groupScope}(t.group_id IS NULL AND
            (t.owner_person_id = ? OR (t.owner_person_id IS NULL AND ? = 'owner'))))`)
      .all(...runIds, ...channelIds, personId, personId) as Array<{ id: string }>
    return rows.map(({ id }) => id)
  }

  const personForRun = (runId: string): string | null => {
    const row = database
      .query(`SELECT m.sender_json FROM runs r
        JOIN messages m ON m.thread_id = r.thread_id AND m.id = r.request_message_id
        WHERE r.id = ? LIMIT 1`)
      .get(runId) as { sender_json: string | null } | null
    if (!row?.sender_json) return null
    try {
      const sender: unknown = JSON.parse(row.sender_json)
      if (!isRecord(sender) || typeof sender.id !== "string") return null
      return authStore.getPerson(sender.id)?.role === "admin" ? sender.id : null
    } catch {
      return null
    }
  }

  const isAdminRun = (runId: string): boolean => personForRun(runId) !== null

  const canAccessNotification = ({
    personId,
    role,
    threadId,
    kind,
    requestId,
  }: {
    personId: string
    role: PersonRole
    threadId: string | null
    kind: string
    requestId: string | null
  }): boolean => {
    if (role === "admin") return true
    if (kind === "approval") return Boolean(requestId && canApprove({ personId, approvalId: requestId }))
    return Boolean(threadId && canAccessThread({ personId, role, threadId }))
  }

  const visibleEvent = ({ personId, role, event }: { personId: string; role: PersonRole; event: UiEvent }): boolean => {
    if (role === "admin") return true
    if (event.type === "transcript.resync" || event.type === "transcript.superseded") return true
    if (event.type === "group.updated") return canAccessGroup({ personId, role, groupId: event.group.id })
    if (event.type === "bot.updated") return canAccessBot({ personId, role, botId: event.bot.id })
    if (event.type === "thread.updated") return canAccessThread({ personId, role, threadId: event.thread.id })
    if (event.type === "message.created" || event.type === "message.updated")
      return canAccessThread({ personId, role, threadId: event.message.threadId })
    if (event.type === "message.delta" || event.type === "message.parts" || event.type === "transcript.rejected")
      return canAccessThread({
        personId,
        role,
        threadId: event.type === "transcript.rejected" ? event.rejection.threadId : event.threadId,
      })
    if (event.type === "run.updated") return canAccessThread({ personId, role, threadId: event.run.threadId })
    if (event.type === "notification.created" || event.type === "notification.resolved")
      return canAccessNotification({
        personId,
        role,
        threadId: event.notification.threadId,
        kind: event.notification.kind,
        requestId: event.notification.requestId,
      })
    if (event.type === "notify")
      return canAccessNotification({
        personId,
        role,
        threadId: event.threadId,
        kind: event.kind ?? "",
        requestId: event.requestId ?? null,
      })
    return false
  }

  const authorizeSocket = ({ personId, role, path }: { personId: string; role: PersonRole; path: string }): boolean => {
    if (role === "admin" || path === "/api/v1/events") return true
    const presence = /^\/api\/v1\/bots\/([a-zA-Z0-9-]+)\/machine\/presence\/socket$/u.exec(path)
    return Boolean(presence && canAccessBot({ personId, role, botId: presence[1] ?? "" }))
  }

  const authorizeHttp = ({
    personId,
    role,
    method,
    pathname,
    body,
  }: {
    personId: string
    role: PersonRole
    method: string
    pathname: string
    body: unknown
  }): RouteDecision | null => {
    if (role === "admin") return null
    const verb = method.toUpperCase()
    if (verb === "POST" && pathname === "/ws-ticket") return null
    if (
      verb === "GET" &&
      [
        "/groups",
        "/bots",
        "/workspace/activity",
        "/search",
        "/runs",
        "/events",
        "/recovery",
        "/notifications",
        "/notifications/pending",
      ].includes(pathname)
    )
      return null
    const groupThreads = /^\/groups\/([^/]+)\/threads$/u.exec(pathname)
    if (groupThreads && ["GET", "POST"].includes(verb))
      return canAccessGroup({ personId, role, groupId: groupThreads[1] ?? "" }) ? null : notFound
    if (verb === "GET" && /^\/bots\/[^/]+\/threads$/u.test(pathname)) {
      const botId = pathname.split("/")[2] ?? ""
      return canAccessBot({ personId, role, botId }) ? null : notFound
    }
    const presenceRoute = /^\/bots\/([^/]+)\/machine\/presence\/socket$/u.exec(pathname)
    if (presenceRoute && verb === "GET")
      return canAccessBot({ personId, role, botId: presenceRoute[1] ?? "" }) ? null : notFound
    if (verb === "POST" && pathname === "/threads") {
      const botId = stringValue(isRecord(body) ? body.botId : null)
      if (botId) return ownsBot({ personId, botId }) ? null : denied
      return database
        .query(`SELECT 1 FROM bots WHERE archived_at IS NULL
        AND (responsible_person_id = ? OR (responsible_person_id IS NULL AND ? = 'owner')) LIMIT 1`)
        .get(personId, personId)
        ? null
        : denied
    }
    if (verb === "POST" && pathname === "/attachments") return null
    const attachmentRoute = /^\/attachments\/([^/]+)(?:\/content)?$/u.exec(pathname)
    if (attachmentRoute && verb === "GET")
      return canAccessAttachment({ personId, role, attachmentId: attachmentRoute[1] ?? "" }) ? null : notFound
    const threadRoute = /^\/threads\/([^/]+)(?:\/(messages|transcript|goal|respond|runs))?$/u.exec(pathname)
    if (threadRoute) {
      const threadId = threadRoute[1] ?? ""
      const action = threadRoute[2] ?? ""
      if (action === "respond" && verb === "POST")
        return canAccessThread({ personId, role, threadId }) ? null : notFound
      if (!canAccessThread({ personId, role, threadId })) return notFound
      if (action === "messages" && ["GET", "POST"].includes(verb)) return null
      if (action === "transcript" && verb === "GET") return null
      if (action === "goal" && verb === "GET") return null
      if (action === "runs" && verb === "GET") return null
      if (!action && verb === "PATCH" && ownsPrivateThread({ personId, threadId })) return null
      return denied
    }
    const approvalRoute = /^\/approvals\/([^/]+)$/u.exec(pathname)
    if (approvalRoute && verb === "POST")
      return canApprove({ personId, approvalId: approvalRoute[1] ?? "" }) ? null : denied
    const runAction = /^\/runs\/([^/]+)\/(cancel|retry)$/u.exec(pathname)
    if (runAction && verb === "POST")
      return canAccessRun({ personId, role, runId: runAction[1] ?? "" }) ? null : notFound
    return denied
  }

  return {
    canAccessGroup,
    canAccessBot,
    accessibleBotIds,
    canAccessThread,
    canAccessRun,
    accessibleRunIds,
    canAccessAttachment,
    canAccessAttachments,
    canAccessNotification,
    authorizeSocket,
    personForRun,
    isAdminRun,
    canApprove,
    ownsPrivateThread,
    ownsBot,
    visibleEvent,
    authorizeHttp,
    channelIdsFor,
  }
}
