// Embed first-party source so compiled releases do not need a separate worker file.
export const walCheckpointSource = `import { Database, constants as sqliteFlags } from "bun:sqlite";

// Connection and timer ownership stay local to this worker's lifetime.
let database;
let timer;
let lastPageMaintenance = 0;
let pageIntervalMs = 5_000;

const stop = () => {
  clearInterval(timer);
  database?.close();
  database = undefined;
};

const fail = () => {
  stop();
  self.postMessage({ type: "error" });
  self.close();
};

const vacuum = (requestId) => {
  if (!database) return self.postMessage({ type: "vacuum-complete", requestId, error: "DATABASE_UNAVAILABLE" });
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA busy_timeout = 0");
    self.postMessage({ type: "vacuum-complete", requestId });
  } catch (error) {
    database.exec("PRAGMA busy_timeout = 0");
    self.postMessage({ type: "vacuum-complete", requestId, error: error?.message || "VACUUM_FAILED" });
  }
};

const reclaimPages = () => {
  if (database.query("PRAGMA auto_vacuum").get().auto_vacuum !== 2) return;

  const started = performance.now();
  const initial = database.query("PRAGMA freelist_count").get().freelist_count;
  // Private counters bound each pass; every 32-page transaction releases the writer.
  let remaining = initial;
  for (let batch = 0; batch < 8 && remaining > 0 && performance.now() - started < 8; batch++) {
    database.exec("PRAGMA incremental_vacuum(32)");
    const next = database.query("PRAGMA freelist_count").get().freelist_count;
    if (next >= remaining) break;
    remaining = next;
  }
  if (remaining < initial)
    self.postMessage({ type: "pages-reclaimed", pages: initial - remaining });
};

const checkpoint = () => {
  if (!database) return;
  try {
    const result = database.query("PRAGMA wal_checkpoint(PASSIVE)").get();
    self.postMessage({ type: "checkpoint", log: result.log, checkpointed: result.checkpointed });
    const now = Date.now();
    if (now - lastPageMaintenance >= pageIntervalMs) {
      lastPageMaintenance = now;
      reclaimPages();
    }
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("SQLITE_BUSY")) return;
    fail();
  }
};

self.onmessage = ({ data }) => {
  if (data.type === "stop") {
    stop();
    self.postMessage({ type: "stopped" });
    self.close();
    return;
  }

  if (data.type === "vacuum") {
    vacuum(data.requestId);
    return;
  }

  if (data.type !== "start") return;

  try {
    database = new Database(data.filename, sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_NOFOLLOW);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL");
    pageIntervalMs = data.pageIntervalMs;
    lastPageMaintenance = Date.now();
    timer = setInterval(checkpoint, data.intervalMs);
    self.postMessage({ type: "ready" });
  } catch {
    fail();
  }
};`
