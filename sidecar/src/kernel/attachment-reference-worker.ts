// Embedded first-party code also works in compiled releases. Historical bodies
// and cold SQLite pages stay on this read-only connection, away from HTTP/turns.
export const attachmentReferenceSource = `import { Database, constants } from "bun:sqlite";
let database;
const references = new Set();
const tables = [
  ["messages", "rowid", "parts_json"],
  ["tool_resolutions", "rowid", "part_json"],
  ["transcript_entries", "id", "event_json"],
  ["ui_event_log", "seq", "event_json"],
  ["send_journal", "rowid", "request_json"],
];
const collect = (value) => {
  if (!value || typeof value !== "object") return;
  Object.entries(value).forEach(([key, item]) => {
    if ((key === "outputAttachmentId" || key === "attachmentId") && typeof item === "string") references.add(item);
    else if (typeof item === "object") collect(item);
  });
};
const scan = async (filename) => {
  database = new Database(filename, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW);
  database.exec("PRAGMA busy_timeout = 0");
  const version = database.query("PRAGMA data_version").get().data_version;
  for (const [table, key, column] of tables) {
    let cursor = 0;
    while (true) {
      // Fetch IDs first and one body at a time: a single legacy body may be huge.
      const rows = database.query("SELECT " + key + " AS cursor FROM " + table + " WHERE " + key + " > ? ORDER BY " + key + " LIMIT 50").all(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const body = database.query("SELECT " + column + " AS json FROM " + table + " WHERE " + key + " = ?").get(row.cursor);
        if (body) collect(JSON.parse(body.json));
        cursor = row.cursor;

      }
      await Bun.sleep(0);
      if (database.query("PRAGMA data_version").get().data_version !== version) throw new Error("changed");
    }
  }
};
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "scan") {
      await scan(data.filename);
      self.postMessage({ type: "ready" });
      return;
    }
    if (data.type === "candidates") {
      self.postMessage({ type: "candidates", ids: data.ids.filter((id) => !references.has(id)) });
    }
  } catch {
    // No body, path or SQLite diagnostic crosses the worker boundary.
    self.postMessage({ type: "error" });
    database?.close();
    self.close();
  }
};`
