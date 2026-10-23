import type { Database } from "bun:sqlite"
import { userInfo } from "node:os"
import type { GroupValidationField, Kernel } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
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
  const getInvalidResponse = (field: GroupValidationField) => ({
    status: 400,
    json: { errorCode: "INVALID_ARGS", field },
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
          if (!groups.validate(input)) return getInvalidResponse(groups.getValidationField(input) ?? "body")
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
          if (!groups.validate(body)) return getInvalidResponse(groups.getValidationField(body) ?? "body")
          if (
            (kernel.db as Database)
              .query(
                "SELECT 1 FROM group_turns t JOIN runs r ON r.id=t.run_id WHERE t.group_id=? AND r.status IN ('queued','starting','running') LIMIT 1",
              )
              .get(existing.id)
          )
            return { status: 409, json: { errorCode: "GROUP_BUSY", error: "Pare os turnos antes de editar o grupo." } }
          const group = groups.save(body, existing)
          kernel.publish({ type: "group.updated", group })
          for (const thread of groups.threads(group.id)) kernel.publish({ type: "thread.updated", thread })
          return { status: 200, json: { group } }
        },
      },
      {
        method: "GET",
        path: "/groups/:id/threads",
        handler: async ({ params }) => ({ status: 200, json: { threads: groups.threads(params.id ?? "") } }),
      },
      {
        method: "POST",
        path: "/groups/:id/threads",
        handler: async ({ params, body }) => {
          const group = groups.get(params.id ?? "")
          if (!group) return { status: 404, json: { errorCode: "NOT_FOUND", error: "Grupo não encontrado" } }
          const title = (body as { title?: unknown })?.title
          if (typeof title !== "string" || !title.trim() || title.length > 200) return getInvalidResponse("title")
          return { status: 201, json: { thread: groups.createThread(group, title.trim()) } }
        },
      },
    ],
  })
}

const getCreateInput = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "avatarShape")) return body

  return { ...body, avatarShape: "classic-none" }
}
