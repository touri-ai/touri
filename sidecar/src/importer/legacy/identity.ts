import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { Kernel, LegacySource } from "@touri/contracts"
import { legacyLocalId } from "./legacyIdentity"

export const sourceOrigin = (source: LegacySource): string =>
  source.kind === "local"
    ? resolve(source.root.replace(/^~(?=\/|$)/, homedir()))
    : `ssh://${source.user}@${source.host.toLowerCase()}:${source.port ?? 22}/${source.root.replace(/\/+$/, "")}`

/** Origin string recorded by imports made before identities were origin-scoped. */
export const legacySourceOrigin = (source: LegacySource): string =>
  source.kind === "local"
    ? sourceOrigin(source)
    : `ssh://${source.user}@${source.host}${source.port ? `:${source.port}` : ""}`

const objectTables = ["bots", "threads", "messages", "routines", "routine_runs", "runs", "provider_sessions"] as const

/** Source IDs are never local primary keys. The import ledger stores origin-scoped
 * mappings. Objects imported before scoping are adopted only with ledger proof that
 * the same origin created them; nothing else can claim an existing local object. */
export const importIdentity = (kernel: Kernel, origin: string, importId: string, legacyOrigin: string = origin) => {
  const database = kernel.db as Database
  const pending = new Map<string, { kind: string; sourceId: string; localId: string }>()
  const allocated = new Set<string>()
  const id = (kind: string, sourceId: string): string => {
    const key = JSON.stringify([origin, kind, sourceId])
    const cached = pending.get(key)
    if (cached) return cached.localId
    const existing = database
      .query("SELECT local_id FROM import_records WHERE source='legacy-identity-v1' AND source_id=?")
      .get(key) as { local_id: string } | null
    const legacy = existing ? null : legacyLocalId({ database, origin: legacyOrigin, kind, sourceId })
    const localId = existing?.local_id ?? legacy ?? kernel.newId()
    if (
      !existing &&
      !legacy &&
      objectTables.some((table) => database.query(`SELECT id FROM ${table} WHERE id=? LIMIT 1`).get(localId))
    )
      throw new Error("Import identity collides with an existing local object")
    const claimed = database
      .query("SELECT source_id FROM import_records WHERE source='legacy-identity-v1' AND local_id=? AND source_id!=?")
      .get(localId, key)
    if (claimed || allocated.has(localId)) throw new Error("Import identity collision")
    if (!/^[A-Za-z0-9_-]+$/.test(localId)) throw new Error("Invalid local import identity")
    allocated.add(localId)
    pending.set(key, { kind, sourceId: key, localId })
    return localId
  }
  const persist = () => {
    for (const value of pending.values())
      database
        .query(
          "INSERT OR IGNORE INTO import_records(source,source_kind,source_id,local_id,content_hash,import_id,imported_at) VALUES ('legacy-identity-v1',?,?,?,'',?,?)",
        )
        .run(
          value.kind === "run" ? "routine_run" : value.kind === "sender" ? "bot" : value.kind,
          value.sourceId,
          value.localId,
          importId,
          Date.now(),
        )
  }
  return { id, persist }
}

export const assertImportOwner = (database: Database, table: string, id: string, column: string, owner: string) => {
  const row = database.query(`SELECT ${column} AS owner FROM ${table} WHERE id=?`).get(id) as { owner: string } | null
  if (row && row.owner !== owner) throw new Error(`Import collision: ${table} ownership differs`)
}
