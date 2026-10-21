export const threadDeletionWorkerSource = `
import { Database, constants } from "bun:sqlite";

let database;
let checkpointBatches = 0;

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

// Rowid windows also bound unrelated history and avoid long writer locks during finalization.
const RECORD_TASKS = [
  ["group_run_links", "EXISTS (SELECT 1 FROM runs owner WHERE owner.id = group_run_links.run_id AND owner.thread_id = ?3) OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = group_run_links.turn_id AND owner.thread_id = ?3)"],
  ["group_turns", "EXISTS (SELECT 1 FROM runs owner WHERE owner.id = group_turns.run_id AND owner.thread_id = ?3)"],
  ["group_message_links", "source_thread_id = ?3"],
  ["send_journal", "thread_id = ?3 OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = send_journal.run_id AND owner.thread_id = ?3)"],
  ["tool_resolutions", "thread_id = ?3 OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = tool_resolutions.run_id AND owner.thread_id = ?3)"],
  ["tool_recovery_pending", "thread_id = ?3 OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = tool_recovery_pending.run_id AND owner.thread_id = ?3)"],
  ["tool_calls", "thread_id = ?3 OR EXISTS (SELECT 1 FROM runs owner WHERE owner.id = tool_calls.run_id AND owner.thread_id = ?3)"],
  ["messages_fts", "thread_id = ?3"],
  ["message_search_rows", "thread_id = ?3"],
  ["rejections", "thread_id = ?3"],
  ["transcript_retention", "thread_id = ?3"],
  ["transcript_pending_deltas", "thread_id = ?3"],
  ["transcript_part_entries", "thread_id = ?3"],
  ["attachment_message_refs", "thread_id = ?3"],
  ["notification_log", "EXISTS (SELECT 1 FROM notifications owner WHERE owner.id = notification_log.notification_id AND owner.thread_id = ?3)"],
  ["recovery_tasks", "EXISTS (SELECT 1 FROM notifications owner WHERE owner.id = recovery_tasks.notification_id AND owner.thread_id = ?3)"],
  ["notifications", "thread_id = ?3"],
  ["provider_sessions", "thread_id = ?3"],
  ["computer_grants", "thread_id = ?3"],
  ["browser_tabs", "owner_thread_id = ?3", "owner_thread_id = NULL"],
  ["routine_runs", "thread_id = ?3", "thread_id = NULL"],
  ["routine_runs", "EXISTS (SELECT 1 FROM runs owner WHERE owner.id = routine_runs.run_id AND owner.thread_id = ?3)", "run_id = NULL"],
  ["routines", "results_thread_id = ?3", "results_thread_id = NULL"],
  ["run_resume_points", "EXISTS (SELECT 1 FROM runs owner WHERE owner.id = run_resume_points.run_id AND owner.thread_id = ?3)"],
  ["run_continuations", "EXISTS (SELECT 1 FROM runs owner WHERE owner.id = run_continuations.run_id AND owner.thread_id = ?3)"],
  ["runs", "thread_id = ?3"],
  ["threads", "parent_thread_id = ?3", "parent_thread_id = NULL"],
  ["threads", "group_thread_id = ?3", "group_thread_id = NULL"],
];

const finalize = (job) => {
  const task = RECORD_TASKS[job.record_task];
  if (!task) {
    database.transaction(() => {
      database.query("DELETE FROM threads WHERE id = ?").run(job.thread_id);
      updateJob(job.thread_id, { phase: "cleanup" });
    })();
    return;
  }
  const [table, predicate, update] = task;
  const rows = database.query("SELECT rowid AS cursor FROM " + table + " WHERE rowid > ? ORDER BY rowid LIMIT 32")
    .all(job.record_cursor);
  if (!rows.length) {
    database.query("UPDATE thread_deletions SET record_task = record_task + 1, record_cursor = 0 WHERE thread_id = ?")
      .run(job.thread_id);
    return;
  }
  const cursor = rows[rows.length - 1].cursor;
  database.transaction(() => {
    const command = update ? "UPDATE " + table + " SET " + update : "DELETE FROM " + table;
    database.query(command + " WHERE rowid > ?1 AND rowid <= ?2 AND (" + predicate + ")")
      .run(job.record_cursor, cursor, job.thread_id);
    database.query("UPDATE thread_deletions SET record_cursor = ?, error_code = NULL, updated_at = ? WHERE thread_id = ?")
      .run(cursor, Date.now(), job.thread_id);
  })();
};

const processBatch = (threadId) => {
  const job = database.query("SELECT * FROM thread_deletions WHERE thread_id = ?").get(threadId);
  if (!job) return { done: true, phase: "done" };
  if (job.phase === "events") processEvents(job);
  if (job.phase === "transcript") processTranscript(job);
  if (job.phase === "messages") processMessages(job);
  if (job.phase === "finalize") finalize(job);
  // Checkpoints run outside write transactions and off the server event loop.
  checkpointBatches += 1;
  if (checkpointBatches >= 32) {
    database.query("PRAGMA wal_checkpoint(PASSIVE)").get();
    checkpointBatches = 0;
  }
  const next = database.query("SELECT phase FROM thread_deletions WHERE thread_id = ?").get(threadId);
  return { done: next?.phase === "cleanup", phase: next?.phase ?? "done" };
};

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    try {
      database = new Database(data.filename, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
      database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0");
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
