import { constants, Database } from "bun:sqlite"
import { backfillWorkspaceAttentionBatch, type WorkspaceAttentionBatchResult } from "./workspace-attention-batch"

export type WorkspaceAttentionWorkerReply =
  | { type: "result"; result: WorkspaceAttentionBatchResult }
  | { type: "busy" }
  | { type: "error" }

// This connection belongs only to the backfill worker and never carries a live request.
let database: Database | undefined

self.onmessage = ({ data: { filename } }: MessageEvent<{ filename: string }>): void => {
  try {
    if (!database) {
      database = new Database(filename, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW)
      database.exec(
        "PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -8192",
      )
    }
    const result = backfillWorkspaceAttentionBatch(database)
    if (result.done) {
      database.close()
      database = undefined
    }
    self.postMessage({ type: "result", result } satisfies WorkspaceAttentionWorkerReply)
  } catch (error) {
    const busy = isSqliteBusy(error)
    if (!busy) {
      database?.close()
      database = undefined
    }
    // Database diagnostics and historical bodies never cross this boundary.
    self.postMessage({ type: busy ? "busy" : "error" } satisfies WorkspaceAttentionWorkerReply)
  }
}

const isSqliteBusy = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  (error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED"))
