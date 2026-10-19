import type { Database } from "bun:sqlite"
import { join, relative } from "node:path"
import type { Kernel, RouteModule } from "@touri/contracts"
import { removePrivateFileAsync } from "../kernel/async-files"
import { collectUnusedOutputBlobs } from "../kernel/data-maintenance"
import { attachmentReferences } from "../kernel/output-blobs"
import { purgeReplayRows } from "../kernel/transcript-storage"
import { createGroupStore } from "./store"

const groupThreads = "SELECT id FROM threads WHERE group_id = ?"
const groupRuns = `SELECT id FROM runs WHERE thread_id IN (${groupThreads})`

export const deleteGroupRoute = (kernel: Kernel): RouteModule["routes"][number] => ({
  method: "DELETE",
  path: "/groups/:id",
  handler: async ({ params }) => {
    const groupId = params.id ?? ""
    if (!createGroupStore(kernel).get(groupId))
      return { status: 404, json: { errorCode: "NOT_FOUND", error: "Grupo não encontrado" } }

    await kernel.services.use("groups.runtime")?.cancelGroupTurns({ groupId })
    const database = kernel.db as Database
    const busy = database
      .query(`SELECT 1 FROM runs WHERE thread_id IN (${groupThreads}) AND status IN ('queued','starting','running')`)
      .get(groupId)
    if (busy)
      return { status: 409, json: { errorCode: "GROUP_BUSY", error: "Pare os turnos antes de apagar o grupo." } }

    const store = kernel.services.use("store.api")
    const threads = database.query(groupThreads).all(groupId) as Array<{ id: string }>
    await Promise.all(threads.map(({ id: threadId }) => store?.flushWritesAsync?.({ threadId })))
    const replay = getGroupReplayRows(database, groupId)
    const attachments = getGroupAttachments(database, groupId, replay)
    await removeGroupFiles(kernel, database, groupId)
    database
      .transaction(() => {
        database
          .query(
            "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
          )
          .run(`storage.deleted-attachments:group:${groupId}`, JSON.stringify([...attachments]), Date.now())
        purgeReplayRows(database, replay)
        deleteGroupHistory(database, groupId)
        database.query("DELETE FROM bot_groups WHERE id = ?").run(groupId)
      })
      .immediate()
    kernel.publish({ type: "transcript.resync" })
    kernel.publish({ type: "group.deleted", groupId })
    await collectUnusedOutputBlobs(database, kernel.paths.appData, Date.now(), null, attachments)
    return { status: 200, json: {} }
  },
})

const getGroupReplayRows = (database: Database, groupId: string): Array<{ seq: number; event_json: string }> =>
  database
    .query(`SELECT seq,event_json FROM ui_event_log e WHERE EXISTS (
      SELECT 1 FROM json_tree(e.event_json) j WHERE
        (j.key IN ('groupId','group_id') AND j.value = ?)
        OR (j.fullkey = '$.group.id' AND j.value = ?)
        OR (j.key IN ('threadId','thread_id','sourceThreadId','groupThreadId') AND j.value IN (${groupThreads}))
        OR (j.fullkey = '$.thread.id' AND j.value IN (${groupThreads}))
    )`)
    .all(groupId, groupId, groupId, groupId) as Array<{ seq: number; event_json: string }>

const getGroupAttachments = (
  database: Database,
  groupId: string,
  replay: Array<{ event_json: string }>,
): Set<string> => {
  const references = database
    .query(`SELECT parts_json AS event_json FROM messages WHERE thread_id IN (${groupThreads})
      UNION ALL SELECT event_json FROM transcript_entries WHERE thread_id IN (${groupThreads})
      UNION ALL SELECT part_json AS event_json FROM tool_resolutions WHERE thread_id IN (${groupThreads})
      UNION ALL SELECT request_json AS event_json FROM send_journal WHERE thread_id IN (${groupThreads})`)
    .all(groupId, groupId, groupId, groupId) as Array<{ event_json: string }>
  // The reference visitor writes only to this fresh, local set.
  const attachments = new Set<string>()
  references.concat(replay).forEach((row) => {
    attachmentReferences(JSON.parse(row.event_json), attachments)
  })
  return attachments
}

const removeGroupFiles = async (kernel: Kernel, database: Database, groupId: string): Promise<void> => {
  const threads = database.query(groupThreads).all(groupId) as Array<{ id: string }>
  const suffixes = ["mcp.json", "settings.json", "system.md"]
  for (const thread of threads)
    for (const suffix of suffixes)
      await removePrivateFileAsync({
        root: kernel.paths.appData,
        path: join(kernel.paths.runDir, "claude", `${thread.id}.${suffix}`),
      })
  const sessions = database
    .query(
      `SELECT DISTINCT rollout_path FROM provider_sessions WHERE thread_id IN (${groupThreads}) AND rollout_path IS NOT NULL`,
    )
    .all(groupId) as Array<{ rollout_path: string }>
  for (const session of sessions) {
    const suffix = relative(kernel.paths.sessionsDir, session.rollout_path)
    if (!suffix || suffix.startsWith("..") || suffix.startsWith("/")) continue
    if (
      database
        .query(`SELECT 1 FROM provider_sessions WHERE rollout_path = ? AND thread_id NOT IN (${groupThreads})`)
        .get(session.rollout_path, groupId)
    )
      continue

    await removePrivateFileAsync({ root: kernel.paths.appData, path: session.rollout_path })
  }
}

const deleteGroupHistory = (database: Database, groupId: string): void => {
  database
    .query(
      `DELETE FROM group_run_links WHERE run_id IN (${groupRuns}) OR turn_id IN (SELECT run_id FROM group_turns WHERE group_id = ?)`,
    )
    .run(groupId, groupId)
  database.query("DELETE FROM group_turns WHERE group_id = ?").run(groupId)
  database.query(`DELETE FROM group_message_links WHERE source_thread_id IN (${groupThreads})`).run(groupId)
  const tables = ["send_journal", "tool_resolutions", "messages_fts", "transcript_retention", "rejections"]
  tables.forEach((table) => {
    database.query(`DELETE FROM ${table} WHERE thread_id IN (${groupThreads})`).run(groupId)
  })
  database.query(`DELETE FROM messages WHERE thread_id IN (${groupThreads})`).run(groupId)
  // Open the existing retention guard only inside the deletion transaction.
  database
    .query(
      "UPDATE transcript_maintenance SET delete_before_id = (SELECT COALESCE(MAX(id), 0) FROM transcript_entries) WHERE id = 1",
    )
    .run()
  database.query(`DELETE FROM transcript_entries WHERE thread_id IN (${groupThreads})`).run(groupId)
  database.query("UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1").run()
  database
    .query(
      `DELETE FROM notification_log WHERE notification_id IN (SELECT id FROM notifications WHERE thread_id IN (${groupThreads}))`,
    )
    .run(groupId)
  database.query(`DELETE FROM notifications WHERE thread_id IN (${groupThreads})`).run(groupId)
  database
    .query(`DELETE FROM tool_calls WHERE thread_id IN (${groupThreads}) OR run_id IN (${groupRuns})`)
    .run(groupId, groupId)
  database.query("DELETE FROM routines WHERE group_id = ?").run(groupId)
  database.query(`DELETE FROM threads WHERE group_id = ?`).run(groupId)
}
