// Embed first-party source so compiled releases do not need a separate worker file.
export const walCheckpointSource = `import { Database, constants as sqliteFlags } from "bun:sqlite";

// Connection and timer ownership stay local to this worker's lifetime.
let database;
let timer;

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

const checkpoint = () => {
  if (!database) return;
  try {
    const result = database.query("PRAGMA wal_checkpoint(PASSIVE)").get();
    self.postMessage({ type: "checkpoint", log: result.log, checkpointed: result.checkpointed });
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

  try {
    database = new Database(data.filename, sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_NOFOLLOW);
    database.exec("PRAGMA busy_timeout = 0; PRAGMA wal_autocheckpoint = 0");
    timer = setInterval(checkpoint, data.intervalMs);
    self.postMessage({ type: "ready" });
  } catch {
    fail();
  }
};`
