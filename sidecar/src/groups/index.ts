import type { Database } from "bun:sqlite"
import { userInfo } from "node:os"
import type { GroupValidationField, Kernel } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
import { getRoutineThreadCandidateIds, getThreadsWithRoutineTitles } from "../store/routine-thread-title"
import { deleteGroupRoute } from "./delete-group"
import { createGroupStore } from "./store"
export const name = "groups"
export const init = async (kernel: Kernel): Promise<void> => {
  const groups = createGroupStore(kernel)
  if (!kernel.services.use("work.defaultPersonId")) kernel.services.provide("work.defaultPersonId", () => "owner")
  if (!kernel.services.use("work.channelPeople")) {
    // Native mode needs a local identity; preserve the authenticated roster installed by Work.
    const accountName = userInfo().username
    kernel.services.provide("work.channelPeople", () => [
      { id: "owner", name: accountName, handle: accountName, avatarSeed: "owner", role: "admin" },
    ])
  }
  const getInvalidResponse = (fields: GroupValidationField[]) => ({
    status: 400,
    json: { errorCode: "INVALID_ARGS", fields },
  })
  kernel.registerRoutes({
    name,
    routes: [
      deleteGroupRoute(kernel),
      {
        method: "GET",
        path: "/groups/:id/people",
        handler: async ({ params, signal }) => {
          const groupId = params.id ?? ""
          const actor = deviceSession(signal)?.person
          const canAccess = kernel.services.use("work.canAccessGroup")
          if (
            !groups.get(groupId) ||
            (canAccess && (!actor || !canAccess({ personId: actor.id, role: actor.role, groupId })))
          )
            return { status: 404, json: { errorCode: "NOT_FOUND", error: "Canal não encontrado" } }

          return { status: 200, json: { people: kernel.services.use("work.channelPeople")?.(groupId) ?? [] } }
        },
      },
      {
        method: "GET",
        path: "/groups",
        handler: async ({ signal }) => {
          const person = deviceSession(signal)?.person
          const all = groups.list()
          const visibleChannelIds =
            person && person.role !== "admin"
              ? new Set(kernel.services.use("work.personChannelIds")?.(person.id) ?? [])
              : null
          const visible = visibleChannelIds ? all.filter((group) => visibleChannelIds.has(group.id)) : all
          return { status: 200, json: { groups: visible } }
        },
      },
      {
        method: "POST",
        path: "/groups",
        handler: async ({ body }) => {
          const input = getCreateInput(body)
          if (!groups.validate(input)) return getInvalidResponse(groups.getValidationFields(input))
          const result = (kernel.db as Database)
            .transaction(() => {
              const group = groups.save(input)
              return { group, thread: groups.createThread(group) }
            })
            .immediate()
          kernel.publish({ type: "group.updated", group: result.group })
          return { status: 201, json: result }
        },
      },
      {
        method: "PATCH",
        path: "/groups/:id",
        handler: async ({ params, body }) => {
          const existing = groups.get(params.id ?? "")
          if (!existing) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Grupo não encontrado" } }
          if (!groups.validate(body)) return getInvalidResponse(groups.getValidationFields(body))

          const removedIds = existing.memberIds.filter((id) => !body.memberIds.includes(id))
          const busyBotId = getBusyRemovedMemberId(kernel.db as Database, existing.id, removedIds)
          if (busyBotId) return { status: 409, json: { errorCode: "GROUP_MEMBER_BUSY", busyBotId } }

          const group = groups.save(body, existing)
          kernel.publish({ type: "group.updated", group })
          for (const thread of groups.threads(group.id)) kernel.publish({ type: "thread.updated", thread })
          return { status: 200, json: { group } }
        },
      },
      {
        method: "GET",
        path: "/groups/:id/threads",
        handler: async ({ params, signal }) => {
          const groupId = params.id ?? ""
          const actor = deviceSession(signal)?.person
          const canAccess = kernel.services.use("work.canAccessGroup")
          if (canAccess && (!actor || !canAccess({ personId: actor.id, role: actor.role, groupId })))
            return { status: 404, json: { errorCode: "NOT_FOUND", error: "Canal não encontrado" } }

          const threads = groups.threads(groupId)
          const titles = await kernel.services
            .use("storage.threadTitles")
            ?.getRoutineTitles(getRoutineThreadCandidateIds(threads), signal)

          return { status: 200, json: { threads: titles ? getThreadsWithRoutineTitles(threads, titles) : threads } }
        },
      },
      {
        method: "POST",
        path: "/groups/:id/threads",
        handler: async ({ params, body }) => {
          const group = groups.get(params.id ?? "")
          if (!group) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Grupo não encontrado" } }
          const title = (body as { title?: unknown })?.title
          if (typeof title !== "string" || !title.trim() || title.length > 200) return getInvalidResponse(["title"])
          return { status: 201, json: { thread: groups.createThread(group, title.trim()) } }
        },
      },
    ],
  })
}

const getCreateInput = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body

  return { color: "#dc2626", avatarShape: "classic-none", coordinatorBotId: null, ...body }
}

const getBusyRemovedMemberId = (db: Database, groupId: string, removedIds: string[]): string | undefined => {
  if (!removedIds.length) return undefined

  // At most 20 members; seek only live runs, never the bot's growing run history.
  const activeMember = db.query(`SELECT 1 FROM runs r INDEXED BY runs_active_workspace
    JOIN threads t ON t.id = r.thread_id
    WHERE r.status IN ('queued','starting','running') AND t.group_id = ? AND r.bot_id = ?
      AND NOT EXISTS (SELECT 1 FROM group_turns g WHERE g.run_id = r.id)
    LIMIT 1`)

  // Coordination rows borrow a recipient's identity but do not represent that bot working.
  return removedIds.find((botId) => activeMember.get(groupId, botId) !== null)
}
