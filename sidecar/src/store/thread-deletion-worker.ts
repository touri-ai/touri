export const threadDeletionWorkerSource = `
import { Database, constants } from "bun:sqlite";

let database;

const EVENT_LIMIT = 128;
const TRANSCRIPT_LIMIT = 64;
const MESSAGE_LIMIT = 32;

const collectAttachments = (value, ids, depth = 0) => {
  if (!value || typeof value !== "object" || depth > 32) return;
  Object.entries(value).forEach(([key, item]) => {
    if ((key === "attachmentId" || key === "outputAttachmentId") && typeof item === "string") ids.add(item);
    if (item && typeof item === "object") collectAttachments(item, ids, depth + 1);
  });
};

const eventReferencesThread = (value, threadId) => {
  if (!value || typeof value !== "object") return false;
  const event = value;
  if (event.threadId === threadId || event.thread_id === threadId) return true;
  if (["thread.updated", "thread.deleted"].includes(event.type) && event.thread?.id === threadId) return true;
  if (
    event.type === "thread.updated" &&
    (event.thread?.groupThreadId === threadId || event.thread?.parentThreadId === threadId)
  )
    return true;
  if (["message.created", "message.updated"].includes(event.type) && event.message?.threadId === threadId) return true;
  if (event.type === "run.updated" && event.run?.threadId === threadId) return true;
  if (["notification.created", "notification.resolved"].includes(event.type) && event.notification?.threadId === threadId)
    return true;
  return event.type === "notify" && event.threadId === threadId;
};

const saveAttachments = (threadId, ids) => {
  const insert = database.query("INSERT OR IGNORE INTO thread_deletion_attachments(thread_id, attachment_id) VALUES (?, ?)");
  ids.forEach((id) => insert.run(threadId, id));
};

const updateJob = (threadId, values) => {
  database.query(\`UPDATE thread_deletions SET
    phase = coalesce(?, phase), event_cursor = coalesce(?, event_cursor),
    event_high_water = coalesce(?, event_high_water), transcript_cursor = coalesce(?, transcript_cursor),
    message_cursor = coalesce(?, message_cursor), error_code = NULL, updated_at = ? WHERE thread_id = ?\`).run(
    values.phase ?? null,
    values.eventCursor ?? null,
    values.eventHighWater ?? null,
    values.transcriptCursor ?? null,
    values.messageCursor ?? null,
    Date.now(),
    threadId,
  );
};

const processEvents = (job) => {
  const highWater = job.event_high_water || Number(database.query("SELECT coalesce(max(seq), 0) AS seq FROM ui_event_log").get().seq);
  const rows = database.query(\`SELECT seq, event_json FROM ui_event_log
    WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?\`).all(job.event_cursor, highWater, EVENT_LIMIT);
  if (!rows.length) {
    updateJob(job.thread_id, { phase: "transcript", transcriptCursor: 0 });
    return;
  }

  const attachments = new Set();
  const deleted = rows.flatMap((row) => {
    let event;
    try {
      event = JSON.parse(row.event_json);
    } catch {
      return [];
    }
    if (!eventReferencesThread(event, job.thread_id)) return [];
    collectAttachments(event, attachments);
    return [row.seq];
  });
  const lastSeq = rows[rows.length - 1].seq;
  database.transaction(() => {
    saveAttachments(job.thread_id, attachments);
    if (deleted.length) {
      const placeholders = deleted.map(() => "?").join(",");
      database.query("UPDATE transcript_maintenance SET ui_delete_before_seq = ? WHERE id = 1").run(Math.max(...deleted));
      database.query("DELETE FROM ui_event_log WHERE seq IN (" + placeholders + ")").run(...deleted);
      database.query("UPDATE transcript_maintenance SET ui_delete_before_seq = 0 WHERE id = 1").run();
    }
    updateJob(job.thread_id, { eventCursor: lastSeq, eventHighWater: highWater });
  })();
};

const processTranscript = (job) => {
  const rows = database.query(\`SELECT id, seq, event_json FROM transcript_entries
    WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?\`).all(job.thread_id, job.transcript_cursor, TRANSCRIPT_LIMIT);
  if (!rows.length) {
    updateJob(job.thread_id, { phase: "messages", messageCursor: "" });
    return;
  }

  const attachments = new Set();
  rows.forEach((row) => {
    try {
      collectAttachments(JSON.parse(row.event_json), attachments);
    } catch {
      return;
    }
  });
  const ids = rows.map((row) => row.id);
  const lastSeq = rows[rows.length - 1].seq;
  database.transaction(() => {
    saveAttachments(job.thread_id, attachments);
    const placeholders = ids.map(() => "?").join(",");
    database.query("UPDATE transcript_maintenance SET delete_before_id = ? WHERE id = 1").run(Math.max(...ids));
    database.query("DELETE FROM transcript_entries WHERE id IN (" + placeholders + ")").run(...ids);
    database.query("UPDATE transcript_maintenance SET delete_before_id = 0 WHERE id = 1").run();
    updateJob(job.thread_id, { transcriptCursor: lastSeq });
  })();
};

const processMessages = (job) => {
  const rows = database.query(\`SELECT id, parts_json FROM messages
    WHERE thread_id = ? AND id > ? ORDER BY id LIMIT ?\`).all(job.thread_id, job.message_cursor, MESSAGE_LIMIT);
  if (!rows.length) {
    updateJob(job.thread_id, { phase: "finalize" });
    return;
  }

  const attachments = new Set();
  rows.forEach((row) => {
    try {
      collectAttachments(JSON.parse(row.parts_json), attachments);
    } catch {
      return;
    }
  });
  const ids = rows.map((row) => row.id);
  const lastId = rows[rows.length - 1].id;
  database.transaction(() => {
    saveAttachments(job.thread_id, attachments);
    const placeholders = ids.map(() => "(?, ?)").join(",");
    const parameters = rows.flatMap((row) => [job.thread_id, row.id]);
    database.query("DELETE FROM messages WHERE (thread_id, id) IN (VALUES " + placeholders + ")").run(...parameters);
    updateJob(job.thread_id, { messageCursor: lastId });
  })();
};

const finalize = (job) => {
  database.transaction(() => {
    database.query("DELETE FROM group_run_links WHERE run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id);
    database.query("DELETE FROM group_turns WHERE run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id);
    database.query("DELETE FROM group_message_links WHERE source_thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM send_journal WHERE thread_id = ? OR run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id, job.thread_id);
    database.query("DELETE FROM tool_resolutions WHERE thread_id = ? OR run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id, job.thread_id);
    database.query("DELETE FROM tool_recovery_pending WHERE thread_id = ? OR run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id, job.thread_id);
    database.query("DELETE FROM tool_calls WHERE thread_id = ? OR run_id IN (SELECT id FROM runs WHERE thread_id = ?)").run(job.thread_id, job.thread_id);
    database.query("DELETE FROM messages_fts WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM message_search_rows WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM rejections WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM transcript_retention WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM transcript_pending_deltas WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM transcript_part_entries WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM attachment_message_refs WHERE thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM notification_log WHERE notification_id IN (SELECT id FROM notifications WHERE thread_id = ?)")
      .run(job.thread_id);
    database.query("DELETE FROM notifications WHERE thread_id = ?").run(job.thread_id);
    database.query("UPDATE routines SET results_thread_id = NULL WHERE results_thread_id = ?").run(job.thread_id);
    database.query("UPDATE threads SET group_thread_id = NULL WHERE group_thread_id = ?").run(job.thread_id);
    database.query("DELETE FROM threads WHERE id = ?").run(job.thread_id);
    updateJob(job.thread_id, { phase: "cleanup" });
  })();
};

const processBatch = (threadId) => {
  const job = database.query("SELECT * FROM thread_deletions WHERE thread_id = ?").get(threadId);
  if (!job) return { done: true, phase: "done" };
  if (job.phase === "events") processEvents(job);
  if (job.phase === "transcript") processTranscript(job);
  if (job.phase === "messages") processMessages(job);
  if (job.phase === "finalize") finalize(job);
  const next = database.query("SELECT phase FROM thread_deletions WHERE thread_id = ?").get(threadId);
  return { done: next?.phase === "cleanup", phase: next?.phase ?? "done" };
};

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    try {
      database = new Database(data.filename, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000");
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({ type: "startup-error", error: String(error) });
    }
    return;
  }
  if (data.type !== "batch" || !database) return;
  try {
    self.postMessage({ type: "batch", id: data.id, result: processBatch(data.threadId) });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "unexpected";
    self.postMessage({ type: "batch-error", id: data.id, busy: code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"), code });
  }
};
`
