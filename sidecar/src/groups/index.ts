import type { Kernel } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
import { deleteGroupRoute } from "./delete-group"
import { createGroupStore } from "./store"
export const name = "groups"
export const init = async (kernel: Kernel): Promise<void> => {
  const groups = createGroupStore(kernel)
  const invalid = {
    status: 400,
    json: {
      errorCode: "INVALID_ARGS",
      error:
        "Informe um nome, mascote e membros válidos; o coordenador deve pertencer ao grupo. Nomes dos membros devem ser únicos.",
    },
  }
  kernel.registerRoutes({
    name,
    routes: [
      deleteGroupRoute(kernel),
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
          if (!groups.validate(body)) return invalid
          const result = (kernel.db as import("bun:sqlite").Database)
            .transaction(() => {
              const group = groups.save(body)
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
          if (!groups.validate(body)) return invalid
          if (
            (kernel.db as import("bun:sqlite").Database)
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
          if (typeof title !== "string" || !title.trim() || title.length > 200) return invalid
          return { status: 201, json: { thread: groups.createThread(group, title.trim()) } }
        },
      },
    ],
  })
}
