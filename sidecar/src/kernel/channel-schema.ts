import type { Database } from "bun:sqlite"
import channelContextIndexesSql from "./migrations/channel-context-indexes.sql" with { type: "text" }
import channelMainIndexSql from "./migrations/channel-main-index.sql" with { type: "text" }
import channelReadsSql from "./migrations/channel-reads.sql" with { type: "text" }

export const applyChannelSchema = (database: Database): void => {
  // Versioned and synchronous upgrades share these additive schema checkpoints.
  const migrations = [
    { key: "channel_reads_since", sql: channelReadsSql },
    { key: "channel_context_indexes_version", sql: channelContextIndexesSql },
    { key: "channel_main_index_version", sql: channelMainIndexSql },
  ]
  migrations.forEach(({ key, sql }) => {
    if (database.query("SELECT 1 FROM schema_meta WHERE key = ?").all(key).length) return

    database.transaction(() => database.exec(sql))()
  })
}
