// Keep the worker as first-party Blob source so compiled releases include it.
export const streamPersistenceWorkerSource = `import { Database, constants as sqliteFlags } from "bun:sqlite";

let database;
let stopped = false;

const isBusy = (error) => typeof error?.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"));

const resolutionOf = (part) => {
  if (part.resolution) return part.resolution;
  if (part.type === "tool_call" && part.ok !== null) return part.ok ? "succeeded" : "failed";
  if (part.type === "command" && part.exitCode !== null) return part.exitCode === 0 ? "succeeded" : "failed";
  return part.type === "file_change" ? "succeeded" : "running";
};

const hasPartGap = (length, patches) => {
  const appended = new Set();
  let maximum = length - 1;
  for (const { partIndex } of patches) {
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) return true;
    if (partIndex < length) continue;
    appended.add(partIndex);
    maximum = Math.max(maximum, partIndex);
  }
  return maximum - length + 1 !== appended.size;
};

const clearPendingProjection = (target) => {
  if (!target) {
    database.exec("DELETE FROM transcript_pending_deltas");
    return;
  }
  database.query("DELETE FROM transcript_pending_deltas WHERE thread_id = ? AND message_id = ?")
    .run(target.threadId, target.messageId);
};

const refreshSearch = (threadId, messageId, text) => {
  database.query(\`DELETE FROM messages_fts WHERE rowid IN (
    SELECT fts_rowid FROM message_search_rows WHERE thread_id = ? AND message_id = ?
  ) AND thread_id = ? AND message_id = ?\`).run(threadId, messageId, threadId, messageId);
  database.query("DELETE FROM message_search_rows WHERE thread_id = ? AND message_id = ?")
    .run(threadId, messageId);
  const inserted = database.query(
    "INSERT INTO messages_fts(text, thread_id, message_id) VALUES (?, ?, ?)",
  ).run(text, threadId, messageId);
  database.query(
    "INSERT INTO message_search_rows(thread_id, message_id, fts_rowid) VALUES (?, ?, ?)",
  ).run(threadId, messageId, inserted.lastInsertRowid);
};

const materialize = (target) => {
  if (!database.query("SELECT 1 FROM transcript_pending_deltas LIMIT 1").get()) return;
  const targetFilter = target ? "AND p.thread_id = ? AND p.message_id = ?" : "";
  const statement = database.query(\`
    SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
      FROM transcript_pending_deltas p
      CROSS JOIN messages m
      CROSS JOIN transcript_entries e INDEXED BY transcript_delta_message
      WHERE m.thread_id = p.thread_id AND m.id = p.message_id \${targetFilter}
        AND e.thread_id = p.thread_id AND json_extract(e.event_json, '$.messageId') = p.message_id
        AND json_extract(e.event_json, '$.type') = 'message.delta' AND e.seq > m.updated_seq
    UNION ALL
    SELECT e.id AS entry_id, e.seq AS delta_seq, e.at, e.event_json, m.id, m.thread_id
      FROM transcript_pending_deltas p
      CROSS JOIN messages m
      CROSS JOIN transcript_part_entries part INDEXED BY transcript_part_message
      CROSS JOIN transcript_entries e
      WHERE m.thread_id = p.thread_id AND m.id = p.message_id \${targetFilter}
        AND part.thread_id = p.thread_id AND part.message_id = p.message_id
        AND e.id = part.entry_id AND e.seq > m.updated_seq
    ORDER BY entry_id\`);
  const rows = target
    ? statement.all(target.threadId, target.messageId, target.threadId, target.messageId)
    : statement.all();
  const projections = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.thread_id, row.id]);
    let projection = projections.get(key);
    if (!projection) {
      const snapshot = database.query("SELECT * FROM messages WHERE thread_id = ? AND id = ?")
        .get(row.thread_id, row.id);
      projection = { ...snapshot, parts: JSON.parse(snapshot.parts_json) };
    }
    const event = JSON.parse(row.event_json);
    if (event.type === "message.parts") {
      if (hasPartGap(projection.parts.length, event.parts)) throw new Error("Transcript part has a gap");
      for (const patch of event.parts) {
        projection.parts[patch.partIndex] = patch.part;
      }
      projection.text = projection.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    } else {
      const part = projection.parts[event.partIndex];
      const text = part?.type === "text" || part?.type === "reasoning" ? part.text : "";
      if (event.offset === undefined || event.offset > text.length) throw new Error("Transcript delta has a gap");
      const suffix = event.delta.slice(Math.max(0, text.length - event.offset));
      const partType = event.partType ?? (part?.type === "reasoning" ? "reasoning" : "text");
      projection.parts[event.partIndex] = {
        ...(part?.type === partType ? part : {}),
        type: partType,
        text: text + suffix,
      };
      if (partType === "text") projection.text += suffix;
    }
    projection.updated_seq = row.delta_seq;
    projection.generation = event.generation ?? projection.generation;
    projection.updated_at = row.at;
    projections.set(key, projection);
  }
  if (!projections.size) {
    clearPendingProjection(target);
    return;
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 1 WHERE id = 1");
  for (const projection of projections.values()) {
    database.query(\`UPDATE messages SET text = ?, parts_json = ?, updated_seq = ?, generation = ?, updated_at = ?
      WHERE thread_id = ? AND id = ?\`).run(
      projection.text,
      JSON.stringify(projection.parts),
      projection.updated_seq,
      projection.generation,
      projection.updated_at,
      projection.thread_id,
      projection.id,
    );
    refreshSearch(projection.thread_id, projection.id, projection.text);
  }
  database.exec("UPDATE transcript_maintenance SET projection_write = 0 WHERE id = 1");
  clearPendingProjection(target);
};

const capture = () => {
  const checkpoint = Number(database.query(
    "SELECT value FROM schema_meta WHERE key = 'transcript_event_checkpoint'",
  ).get().value);
  const statement = database.prepare("SELECT id, at, event_json FROM transcript_entries WHERE id > ? ORDER BY id");
  let last = checkpoint;
  try {
    for (const row of statement.iterate(checkpoint)) {
      last = row.id;
      const event = JSON.parse(row.event_json);
      if (event.legacy) continue;
      let stored = row.event_json;
      if (event.ref) {
        stored = row.event_json;
      } else if (event.type === "message.created" || event.type === "message.updated") {
        if (event.message.updatedSeq !== undefined) stored = JSON.stringify({
          type: event.type,
          ref: true,
          threadId: event.message.threadId,
          messageId: event.message.id,
          seq: event.message.updatedSeq,
        });
      } else if (event.type === "message.delta" || event.type === "message.parts") {
        stored = JSON.stringify({
          type: event.type,
          ref: true,
          threadId: event.threadId,
          messageId: event.messageId,
          seq: event.updatedSeq ?? 0,
        });
      }
      database.query("INSERT INTO ui_event_log(at, event_json) VALUES (?, ?)").run(row.at, stored);
    }
  } finally {
    statement.finalize();
  }
  if (last > checkpoint) database.query(
    "UPDATE schema_meta SET value = ? WHERE key = 'transcript_event_checkpoint'",
  ).run(String(last));
};

const recordRejection = (event, reason) => {
  const thread = database.query("SELECT generation, updated_seq FROM threads WHERE id = ?")
    .get(event.threadId);
  const previousSeq = Math.max(
    thread?.updated_seq ?? 0,
    database.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_entries WHERE thread_id = ?")
      .get(event.threadId).seq,
  );
  const rejection = {
    threadId: event.threadId,
    messageId: event.messageId,
    partIndex: Number.isSafeInteger(event.partIndex) ? event.partIndex : null,
    reason,
    seq: previousSeq + 1,
    generation: thread?.generation ?? 1,
    expectedGeneration: Number.isSafeInteger(event.generation) ? event.generation ?? null : null,
    expectedSeq: Number.isSafeInteger(event.expectedSeq) ? event.expectedSeq ?? null : null,
    at: Date.now(),
  };
  database.query("INSERT INTO rejections(thread_id, seq, generation, record_json, at) VALUES (?, ?, ?, ?, ?)")
    .run(rejection.threadId, rejection.seq, rejection.generation, JSON.stringify(rejection), rejection.at);
  database.query("UPDATE threads SET updated_seq = ? WHERE id = ?").run(rejection.seq, rejection.threadId);
  database.query(\`INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
    VALUES (?, ?, ?, ?, ?)\`).run(
    rejection.threadId,
    rejection.seq,
    rejection.generation,
    JSON.stringify({ type: "transcript.rejected", rejection }),
    rejection.at,
  );
  return { type: "transcript.rejected", rejection };
};

const eventProjection = (event, cache) => {
  const key = JSON.stringify([event.threadId, event.messageId]);
  const cached = cache.get(key);
  if (cached) return cached;
  const row = database.query("SELECT text, parts_json, status, generation, updated_seq FROM messages WHERE thread_id = ? AND id = ?")
    .get(event.threadId, event.messageId);
  if (!row) return null;
  const projection = {
    text: row.text,
    parts: JSON.parse(row.parts_json),
    status: row.status,
    generation: row.generation,
    updatedSeq: row.updated_seq,
  };
  cache.set(key, projection);
  return projection;
};

const getBatchResult = (id, entryIds, quarantined) => {
  const published = entryIds.map((entryId) => {
    const row = database.query("SELECT event_json FROM transcript_entries WHERE id = ?").get(entryId);
    if (!row) throw new Error("Stream batch journal entry is missing");
    return JSON.parse(row.event_json);
  });
  return {
    type: "committed", id, quarantined,
    events: published.filter((event) => event.type === "message.delta" || event.type === "message.parts"),
    rejected: published.filter((event) => event.type === "transcript.rejected"),
    published,
  };
};

const writeBatch = (batch) => {
  const previous = database.query("SELECT batch_id, result_json FROM stream_writer_state WHERE id = 1").get();
  if (previous?.batch_id === batch.id) {
    const saved = JSON.parse(previous.result_json);
    return getBatchResult(batch.id, saved.entryIds, batch.quarantine === true);
  }
  const firstEntryId = database.query("SELECT COALESCE(MAX(id), 0) AS id FROM transcript_entries").get().id;
  // Batch projections stay local and mutable so one transaction can rebase provider chunks in order.
  const committed = [];
  const rejected = [];
  const published = [];
  const projections = new Map();
  const targets = new Map();
  for (const event of batch.events) {
    if (event.type === "stream.rejection") continue;
    targets.set(JSON.stringify([event.threadId, event.messageId]), {
      threadId: event.threadId,
      messageId: event.messageId,
    });
  }
  if (!batch.quarantine) for (const target of targets.values()) materialize(target);
  for (const event of batch.events) {
    if (event.type === "stream.rejection" || batch.quarantine) {
      const rejection = recordRejection(event, event.type === "stream.rejection" ? event.reason : "validation");
      rejected.push(rejection);
      published.push(rejection);
      continue;
    }
    const thread = database.query("SELECT generation, updated_seq FROM threads WHERE id = ?")
      .get(event.threadId);
    const head = database.query("SELECT status, run_id, updated_seq FROM messages WHERE thread_id = ? AND id = ?")
      .get(event.threadId, event.messageId);
    const run = head?.run_id
      ? database.query("SELECT status, thread_id FROM runs WHERE id = ?").get(head.run_id)
      : null;
    if (!thread || !head || thread.generation !== event.generation || head.status !== "streaming" ||
      (run && !["queued", "starting", "running"].includes(run.status))) {
      if (event.type === "message.delta") {
        const rejection = recordRejection(event, "stale_generation");
        rejected.push(rejection);
        published.push(rejection);
      }
      continue;
    }
    const snapshot = event.snapshotSeq !== undefined && head.updated_seq > event.snapshotSeq
      ? database.query("SELECT event_json FROM transcript_entries WHERE thread_id = ? AND seq = ?")
          .get(event.threadId, head.updated_seq)
      : null;
    if (snapshot && ["message.created", "message.updated"].includes(JSON.parse(snapshot.event_json).type)) {
      const rejection = recordRejection(event, "seq_conflict");
      rejected.push(rejection);
      published.push(rejection);
      continue;
    }
    delete event.snapshotSeq;
    if (event.type === "message.delta" && event.expectedSeq !== undefined && event.expectedSeq !== thread.updated_seq) {
      const rejection = recordRejection(event, "seq_conflict");
      rejected.push(rejection);
      published.push(rejection);
      continue;
    }
    delete event.expectedSeq;
    const nextSeq = thread.updated_seq + 1;
    if (database.query("SELECT 1 FROM transcript_entries WHERE thread_id = ? AND seq = ?")
      .get(event.threadId, nextSeq)) {
      if (event.type === "message.delta") {
        const rejection = recordRejection(event, "seq_conflict");
        rejected.push(rejection);
        published.push(rejection);
      }
      continue;
    }
    const projection = eventProjection(event, projections);
    if (!projection) continue;
    if (event.type === "message.delta") {
      const part = projection.parts[event.partIndex];
      if (event.partIndex > projection.parts.length ||
        (part && part.type !== "text" && part.type !== "reasoning")) {
        const rejection = recordRejection(event, "validation");
        rejected.push(rejection);
        published.push(rejection);
        continue;
      }
      const text = part && typeof part.text === "string" ? part.text : "";
      event.offset = text.length;
      const type = event.partType ?? "text";
      projection.parts[event.partIndex] = { ...(part?.type === type ? part : {}), type, text: text + event.delta };
      if (type === "text") projection.text += event.delta;
    } else {
      const invalid = hasPartGap(projection.parts.length, event.parts);
      if (invalid) {
        rejected.push(recordRejection(event, "validation"));
        continue;
      }
      for (const patch of event.parts)
        projection.parts[patch.partIndex] = patch.part;
      projection.text = projection.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    }
    const seq = nextSeq;
    event.updatedSeq = seq;
    database.query("UPDATE threads SET updated_seq = ? WHERE id = ?").run(seq, event.threadId);
    const entry = database.query(\`INSERT INTO transcript_entries(thread_id, seq, generation, event_json, at)
      VALUES (?, ?, ?, ?, ?)\`).run(
      event.threadId,
      seq,
      event.generation ?? 1,
      JSON.stringify(event),
      event.updatedAt ?? Date.now(),
    );
    if (event.type === "message.parts") {
      database.query("INSERT INTO transcript_part_entries(entry_id, thread_id, message_id) VALUES (?, ?, ?)")
        .run(entry.lastInsertRowid, event.threadId, event.messageId);
      if (head.run_id && run?.thread_id === event.threadId) {
        for (const { part } of event.parts) {
          if (!("callId" in part)) continue;
          database.query(\`INSERT INTO tool_resolutions(run_id, call_id, thread_id, part_json, resolution, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, call_id) DO UPDATE SET
            part_json = excluded.part_json, resolution = excluded.resolution, resolved_at = excluded.resolved_at
            WHERE tool_resolutions.part_json IS NOT excluded.part_json
              OR tool_resolutions.resolution IS NOT excluded.resolution
              OR tool_resolutions.resolved_at IS NOT excluded.resolved_at\`).run(
            head.run_id,
            part.callId,
            event.threadId,
            JSON.stringify(part),
            resolutionOf(part),
            part.resolvedAt ?? null,
          );
        }
      }
    }
    projection.updatedSeq = seq;
    committed.push(event);
    published.push(event);
  }
  capture();
  if (!batch.quarantine) for (const target of targets.values()) materialize(target);
  const result = { type: "committed", id: batch.id, events: committed, rejected, published, quarantined: batch.quarantine === true };
  database.query("UPDATE stream_writer_state SET batch_id = ?, result_json = ? WHERE id = 1")
    .run(batch.id, JSON.stringify({ entryIds: database.query(
      "SELECT id FROM transcript_entries WHERE id > ? ORDER BY id",
    ).all(firstEntryId).map((entry) => entry.id) }));
  return result;
};

self.onmessage = ({ data }) => {
  if (data.type === "stop") {
    stopped = true;
    database?.close();
    database = undefined;
    self.postMessage({ type: "stopped" });
    self.close();
    return;
  }
  if (data.type === "start") {
    try {
      database = new Database(data.filename, sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_NOFOLLOW);
      database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -65536");
      database.transaction(() => {
        capture();
        materialize();
      }).immediate();
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "startup-error",
        busy: isBusy(error),
        code: typeof error?.code === "string" ? error.code : "UNKNOWN",
      });
    }
    return;
  }
  if (stopped || !database) return;
  if (data.type !== "batch") return;
  try {
    const result = database.transaction(() => writeBatch(data.batch)).immediate();
    self.postMessage(result);
  } catch (error) {
    self.postMessage({ type: "batch-error", id: data.batch.id, busy: isBusy(error) });
  }
};`
