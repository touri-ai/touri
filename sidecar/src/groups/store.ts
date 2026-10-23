import type { Database } from "bun:sqlite"
import type { BotGroup, ChannelPerson, GroupInput, GroupValidationField, Kernel, Thread } from "@touri/contracts"
import { validAvatarColor, validAvatarShape } from "@touri/contracts/avatar"
import { getMentionedPeople } from "./people"

export const createGroupStore = (kernel: Kernel) => {
  const db = kernel.db as Database
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Store unavailable")
  const get = (id: string): BotGroup | null => {
    const row = db.query("SELECT * FROM bot_groups WHERE id = ?").get(id) as {
      id: string
      name: string
      color: string
      avatar_shape: BotGroup["avatarShape"]
      avatar_seed: string
      coordinator_bot_id: string | null
      created_at: number
      updated_at: number
    } | null
    if (!row) return null
    const members = db.query("SELECT bot_id FROM group_members WHERE group_id = ? ORDER BY position").all(id) as {
      bot_id: string
    }[]
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      avatarShape: row.avatar_shape,
      avatarSeed: row.avatar_seed,
      memberIds: members.map((m) => m.bot_id),
      coordinatorBotId: row.coordinator_bot_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  const list = (): BotGroup[] =>
    (db.query("SELECT id FROM bot_groups ORDER BY created_at, rowid").all() as { id: string }[]).flatMap(({ id }) => {
      const group = get(id)
      return group ? [group] : []
    })
  const getValidationField = (input: unknown): GroupValidationField | undefined => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "body"
    const value = input as Partial<GroupInput>
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80) return "name"
    if (!validAvatarColor(value.color)) return "color"
    if (!validAvatarShape(value.avatarShape)) return "avatarShape"
    const memberIds = value.memberIds
    if (
      !Array.isArray(memberIds) ||
      memberIds.length < 1 ||
      memberIds.length > 20 ||
      new Set(memberIds).size !== memberIds.length
    )
      return "memberIds"
    const members = memberIds.map((id) => (typeof id === "string" ? store.getBot({ botId: id }) : null))
    if (members.some((bot) => !bot || bot.archivedAt)) return "memberIds"
    if (new Set(members.map((bot) => bot?.name.toLocaleLowerCase())).size !== memberIds.length) return "memberIds"
    if (value.coordinatorBotId !== null && !memberIds.includes(value.coordinatorBotId ?? "")) return "coordinatorBotId"

    return undefined
  }
  const validate = (input: unknown): input is GroupInput => getValidationField(input) === undefined
  const save = (input: GroupInput, existing?: BotGroup): BotGroup =>
    db
      .transaction(() => {
        const id = existing?.id ?? kernel.newId()
        const at = Date.now()
        db.query(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,coordinator_bot_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,
      avatar_shape=excluded.avatar_shape,coordinator_bot_id=excluded.coordinator_bot_id,updated_at=excluded.updated_at`).run(
          id,
          input.name.trim(),
          input.color,
          input.avatarShape,
          existing?.avatarSeed ?? id,
          input.coordinatorBotId,
          existing?.createdAt ?? at,
          at,
        )
        db.query("DELETE FROM group_members WHERE group_id = ?").run(id)
        input.memberIds.forEach((botId, position) => {
          db.query("INSERT INTO group_members VALUES(?,?,?)").run(id, botId, position)
        })
        db.query("UPDATE threads SET bot_id=? WHERE group_id=? AND group_thread_id IS NULL").run(
          input.memberIds[0] ?? "",
          id,
        )
        const group = get(id)
        if (!group) throw new Error("Group missing after save")
        return group
      })
      .immediate()
  const threads = (groupId: string): Thread[] =>
    (
      db
        .query(
          "SELECT id FROM threads WHERE group_id = ? AND group_thread_id IS NULL AND archived_at IS NULL ORDER BY updated_at DESC",
        )
        .all(groupId) as { id: string }[]
    ).flatMap(({ id }) => {
      const t = store.getThread({ threadId: id })
      return t ? [t] : []
    })
  const createThread = (group: BotGroup, title = group.name): Thread => {
    const first = group.memberIds[0]
    if (!first) throw new Error("Group has no members")
    const created = store.createThread({ botId: first, kind: "chat", title, groupId: group.id })
    if (!created.success) throw new Error(created.error)
    return created.thread
  }
  const participant = (group: BotGroup, threadId: string, botId: string): Thread => {
    const row = db.query("SELECT id FROM threads WHERE group_thread_id = ? AND bot_id = ?").get(threadId, botId) as {
      id: string
    } | null
    const existing = row ? store.getThread({ threadId: row.id }) : null
    if (existing) {
      kernel.publish({ type: "thread.updated", thread: existing })
      return existing
    }
    const created = store.createThread({
      botId,
      kind: "chat",
      title: group.name,
      groupId: group.id,
      groupThreadId: threadId,
    })
    if (!created.success) throw new Error(created.error)
    return created.thread
  }
  const removeBot = (botId: string): BotGroup[] => {
    const affected = db
      .query(
        "SELECT id FROM bot_groups WHERE id IN (SELECT group_id FROM group_members WHERE bot_id = ?) OR coordinator_bot_id = ?",
      )
      .all(botId, botId) as Array<{ id: string }>

    db.query("DELETE FROM group_members WHERE bot_id = ?").run(botId)
    affected.forEach((group) => {
      db.query(
        "UPDATE bot_groups SET coordinator_bot_id = CASE WHEN coordinator_bot_id = ? THEN NULL ELSE coordinator_bot_id END, updated_at = ? WHERE id = ?",
      ).run(botId, Date.now(), group.id)
    })

    return affected.flatMap(({ id }) => {
      const group = get(id)
      return group ? [group] : []
    })
  }
  return { get, list, getValidationField, validate, save, threads, createThread, participant, removeBot }
}

/** Only explicit bot mentions route human channel messages, in first-mention order. */
export const routeGroupMessage = (
  group: BotGroup,
  bots: { id: string; name: string }[],
  text: string,
  people: ChannelPerson[] = [],
): string[] => {
  const identities = [
    ...people.map((person) => ({ ...person, id: `person:${person.id}` })),
    ...bots.filter((bot) => group.memberIds.includes(bot.id)),
  ]

  return getMentionedPeople(text, identities)
    .filter(({ id }) => !id.startsWith("person:"))
    .map(({ id }) => id)
}

export const getGroupActionText = (text: string, names: string[]) => {
  const missing = names.filter((name) => getMentionPosition(name, text) === undefined)
  if (!missing.length) return text

  return `${missing.map((name) => `@${/\s/.test(name) ? JSON.stringify(name) : name}`).join(" ")} ${text}`
}

const getMentionPosition = (name: string, text: string) => {
  const escaped = [JSON.stringify(name), name].map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const match = new RegExp(`(?:^|\\s)@(?:${escaped})(?=$|[^\\p{L}\\p{N}_-])`, "iu").exec(text)

  return match?.index
}
