import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

/**
 * Work-effect journal. Effects that leave the process boundary (managed process spawns) are
 * recorded as INTENT before they happen, then identity, then result. Each turn has its own
 * checksum chain, a canonical manifest derived from the validated prefix of that chain and a
 * versioned root that is published before the turn is marked successful.
 *
 * Recovery only trusts validated records. An effect whose outcome cannot be observed becomes
 * "uncertain": it blocks automatic repetition and is surfaced to the user. Nothing here rolls
 * back the filesystem.
 */

const GENESIS = "genesis"
const UNSCOPED_TURN = "unscoped"
const RECORD_KINDS = ["intent", "identity", "result", "uncertain", "acknowledged"] as const

export type WorkRecordKind = (typeof RECORD_KINDS)[number]

export type WorkEffectState = "intent" | "running" | "finished" | "failed" | "uncertain"

export type WorkEffect = {
  effectId: string
  turnId: string
  threadId: string | null
  key: string
  description: string
  startedAt: number
  state: WorkEffectState
  pid: number | null
  pgid: number | null
  pidStart: string | null
  processRunId: string | null
  status: string | null
  exitCode: number | null
  reason: string | null
  acknowledged: boolean
}

export type WorkObservation =
  | { kind: "finished"; status: "exited" | "crashed" | "stopped"; exitCode: number | null }
  | { kind: "unobservable"; reason: string }

export type WorkRoot = {
  turnId: string
  version: number
  root: string
  effectCount: number
  manifest: Array<WorkEffect>
}

export type WorkStateHooks = {
  afterAppend?: (record: { turnId: string; effectId: string; kind: WorkRecordKind }) => void
  beforePublishRoot?: (turnId: string) => void
}

export type WorkStateFailure = { success: false; error: string }
export type BeginEffectResult = { success: true; effectId: string; fresh: boolean } | WorkStateFailure
export type AppendResult = { success: true } | WorkStateFailure
export type PublishRootResult = ({ success: true } & { root: WorkRoot; changed: boolean }) | WorkStateFailure
export type RecoverResult = {
  success: true
  uncertain: Array<WorkEffect>
  finished: number
  truncated: number
}

export type WorkState = {
  beginEffect: (args: {
    turnId: string | null
    threadId: string | null
    key: string
    description: string
    effectId: string
  }) => BeginEffectResult
  recordIdentity: (args: {
    effectId: string
    turnId: string | null
    pid?: number | null
    pgid?: number | null
    pidStart?: string | null
    processRunId?: string | null
  }) => AppendResult
  recordResult: (args: {
    effectId: string
    turnId: string | null
    status: string
    exitCode: number | null
  }) => AppendResult
  acknowledgeKey: (args: { key: string }) => AppendResult
  isBlocked: (args: { key: string }) => boolean
  rebuild: (args: { turnId: string }) => Array<WorkEffect>
  recover: (args: { observe: (effect: WorkEffect) => WorkObservation; before?: number }) => RecoverResult
  publishRoot: (args: { turnId: string }) => PublishRootResult
  authoritativeRoot: (args: { turnId: string }) => WorkRoot | null
  verifyRoot: (args: { turnId: string }) => boolean
}

type JournalRow = {
  seq: number
  turn_id: string
  effect_id: string
  kind: string
  payload: string
  prev_checksum: string
  checksum: string
  at: number
}

type Payload = Record<string, unknown>

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

const rowChecksum = (
  row: Pick<JournalRow, "turn_id" | "effect_id" | "kind" | "payload" | "prev_checksum" | "at">,
): string =>
  sha256([row.prev_checksum, row.turn_id, row.effect_id, row.kind, row.payload, String(row.at)].join("\u0000"))

const isKind = (value: string): value is WorkRecordKind => (RECORD_KINDS as ReadonlyArray<string>).includes(value)

const parsePayload = (text: string): Payload | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Payload) : null
  } catch {
    return null
  }
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null)
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)

const validPrefix = (rows: Array<JournalRow>): Array<JournalRow> => {
  const broken = rows.findIndex((row, index) => {
    const prev = index === 0 ? GENESIS : (rows[index - 1]?.checksum ?? GENESIS)
    const valid =
      isKind(row.kind) &&
      parsePayload(row.payload) !== null &&
      row.prev_checksum === prev &&
      row.checksum === rowChecksum(row)
    return !valid
  })
  return broken < 0 ? rows : rows.slice(0, broken)
}

const emptyEffect = ({ row, payload }: { row: JournalRow; payload: Payload }): WorkEffect => ({
  effectId: row.effect_id,
  turnId: row.turn_id,
  threadId: text(payload.threadId),
  key: text(payload.key) ?? "",
  description: text(payload.description) ?? "",
  startedAt: row.at,
  state: "intent",
  pid: null,
  pgid: null,
  pidStart: null,
  processRunId: null,
  status: null,
  exitCode: null,
  reason: null,
  acknowledged: false,
})

const applyRecord = ({
  effect,
  row,
  payload,
}: {
  effect: WorkEffect
  row: JournalRow
  payload: Payload
}): WorkEffect => {
  if (row.kind === "identity")
    return {
      ...effect,
      state: effect.state === "intent" ? "running" : effect.state,
      pid: num(payload.pid) ?? effect.pid,
      pgid: num(payload.pgid) ?? effect.pgid,
      pidStart: text(payload.pidStart) ?? effect.pidStart,
      processRunId: text(payload.processRunId) ?? effect.processRunId,
    }
  if (row.kind === "result") {
    const status = text(payload.status)
    return {
      ...effect,
      state: status === "crashed" || status === "failed" ? "failed" : "finished",
      status,
      exitCode: num(payload.exitCode),
      reason: null,
      acknowledged: false,
    }
  }
  if (row.kind === "uncertain")
    return { ...effect, state: "uncertain", reason: text(payload.reason), acknowledged: false }
  if (row.kind === "acknowledged") return { ...effect, acknowledged: true }
  return effect
}

/** Folds validated records into effects, ordered by the sequence of their intent record. */
const foldEffects = (rows: Array<JournalRow>): Array<WorkEffect> => {
  const effects = rows.reduce<Map<string, WorkEffect>>((map, row) => {
    const payload = parsePayload(row.payload)
    if (payload === null) return map
    const current = map.get(row.effect_id)
    if (row.kind === "intent") return current ? map : map.set(row.effect_id, emptyEffect({ row, payload }))
    return current ? map.set(row.effect_id, applyRecord({ effect: current, row, payload })) : map
  }, new Map())
  return [...effects.values()]
}

const isOpen = (effect: WorkEffect): boolean => effect.state === "intent" || effect.state === "running"

const turnOf = (turnId: string | null): string => turnId ?? UNSCOPED_TURN

const failure = (error: unknown): WorkStateFailure => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
})

/** Opens the work journal over an already migrated database. */
export const createWorkState = ({
  database,
  now,
  hooks,
}: {
  database: Database
  now?: () => number
  hooks?: WorkStateHooks
}): WorkState => {
  const clock = now ?? Date.now

  const readRows = (turnId: string): Array<JournalRow> =>
    database.query("SELECT * FROM work_journal WHERE turn_id = ? ORDER BY seq").all(turnId) as Array<JournalRow>

  const validRows = (turnId: string): Array<JournalRow> => validPrefix(readRows(turnId))

  const append = ({
    turnId,
    effectId,
    kind,
    payload,
  }: {
    turnId: string
    effectId: string
    kind: WorkRecordKind
    payload: Payload
  }): AppendResult => {
    try {
      database
        .transaction(() => {
          const last = validRows(turnId).at(-1)
          const base = {
            turn_id: turnId,
            effect_id: effectId,
            kind,
            payload: JSON.stringify(payload),
            prev_checksum: last?.checksum ?? GENESIS,
            at: clock(),
          }
          database
            .query(
              "INSERT INTO work_journal (turn_id, effect_id, kind, payload, prev_checksum, checksum, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(base.turn_id, base.effect_id, base.kind, base.payload, base.prev_checksum, rowChecksum(base), base.at)
        })
        .immediate()
      hooks?.afterAppend?.({ turnId, effectId, kind })
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  }

  const rebuild = ({ turnId }: { turnId: string }): Array<WorkEffect> => foldEffects(validRows(turnId))

  const findEffect = ({ turnId, effectId }: { turnId: string; effectId: string }): WorkEffect | null =>
    rebuild({ turnId }).find((effect) => effect.effectId === effectId) ?? null

  const beginEffect: WorkState["beginEffect"] = ({ turnId, threadId, key, description, effectId }) => {
    const turn = turnOf(turnId)
    if (findEffect({ turnId: turn, effectId })) return { success: true, effectId, fresh: false }
    const appended = append({ turnId: turn, effectId, kind: "intent", payload: { key, description, threadId } })
    return appended.success ? { success: true, effectId, fresh: true } : appended
  }

  const recordIdentity: WorkState["recordIdentity"] = ({ effectId, turnId, ...identity }) =>
    append({ turnId: turnOf(turnId), effectId, kind: "identity", payload: identity })

  const recordResult: WorkState["recordResult"] = ({ effectId, turnId, status, exitCode }) =>
    append({ turnId: turnOf(turnId), effectId, kind: "result", payload: { status, exitCode } })

  const allTurns = (): Array<string> =>
    (database.query("SELECT DISTINCT turn_id FROM work_journal").all() as Array<{ turn_id: string }>).map(
      (row) => row.turn_id,
    )

  const isBlockedIn = ({ turnId, key }: { turnId: string; key: string }): Array<WorkEffect> =>
    rebuild({ turnId }).filter((effect) => effect.key === key && effect.state === "uncertain" && !effect.acknowledged)

  const blockingEffects = (key: string): Array<WorkEffect> =>
    (
      database.query("SELECT DISTINCT turn_id FROM work_journal WHERE kind = 'uncertain'").all() as Array<{
        turn_id: string
      }>
    ).flatMap((row) => isBlockedIn({ turnId: row.turn_id, key }))

  const isBlocked: WorkState["isBlocked"] = ({ key }) => blockingEffects(key).length > 0

  const acknowledgeKey: WorkState["acknowledgeKey"] = ({ key }) => {
    const results = blockingEffects(key).map((effect) =>
      append({ turnId: effect.turnId, effectId: effect.effectId, kind: "acknowledged", payload: {} }),
    )
    return results.find((result) => !result.success) ?? { success: true }
  }

  const truncateTail = (turnId: string): number => {
    const all = readRows(turnId)
    const valid = validPrefix(all)
    if (valid.length === all.length) return 0
    const lastSeq = valid.at(-1)?.seq ?? 0
    database.query("DELETE FROM work_journal WHERE turn_id = ? AND seq > ?").run(turnId, lastSeq)
    return all.length - valid.length
  }

  const resolveEffect = ({
    effect,
    observe,
  }: {
    effect: WorkEffect
    observe: (effect: WorkEffect) => WorkObservation
  }): { uncertain: WorkEffect | null; finished: boolean } => {
    const observation = observe(effect)
    if (observation.kind === "finished") {
      recordResult({
        effectId: effect.effectId,
        turnId: effect.turnId,
        status: observation.status,
        exitCode: observation.exitCode,
      })
      return { uncertain: null, finished: true }
    }
    append({
      turnId: effect.turnId,
      effectId: effect.effectId,
      kind: "uncertain",
      payload: { reason: observation.reason },
    })
    return { uncertain: { ...effect, state: "uncertain", reason: observation.reason }, finished: false }
  }

  const recover: WorkState["recover"] = ({ observe, before }) => {
    const turns = allTurns()
    const truncated = turns.reduce((total, turnId) => total + truncateTail(turnId), 0)
    const resolved = turns.flatMap((turnId) =>
      rebuild({ turnId })
        .filter((effect) => isOpen(effect) && (before === undefined || effect.startedAt < before))
        .map((effect) => resolveEffect({ effect, observe })),
    )
    return {
      success: true,
      truncated,
      finished: resolved.filter((item) => item.finished).length,
      uncertain: resolved.flatMap((item) => (item.uncertain ? [item.uncertain] : [])),
    }
  }

  const manifestRoot = (manifest: Array<WorkEffect>): string => sha256(JSON.stringify(manifest))

  const authoritativeRoot: WorkState["authoritativeRoot"] = ({ turnId }) => {
    const row = database
      .query("SELECT * FROM work_roots WHERE turn_id = ? ORDER BY version DESC LIMIT 1")
      .get(turnId) as {
      turn_id: string
      version: number
      root: string
      effect_count: number
      manifest: string
    } | null
    if (!row) return null
    return {
      turnId: row.turn_id,
      version: row.version,
      root: row.root,
      effectCount: row.effect_count,
      manifest: JSON.parse(row.manifest) as Array<WorkEffect>,
    }
  }

  const publishRoot: WorkState["publishRoot"] = ({ turnId }) => {
    try {
      hooks?.beforePublishRoot?.(turnId)
      return database
        .transaction((): PublishRootResult => {
          const manifest = rebuild({ turnId })
          const root = manifestRoot(manifest)
          const prior = authoritativeRoot({ turnId })
          if (prior?.root === root) return { success: true, root: prior, changed: false }
          const version = (prior?.version ?? 0) + 1
          database
            .query(
              "INSERT INTO work_roots (turn_id, version, root, effect_count, manifest, published_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(turnId, version, root, manifest.length, JSON.stringify(manifest), clock())
          return {
            success: true,
            changed: true,
            root: { turnId, version, root, effectCount: manifest.length, manifest },
          }
        })
        .immediate()
    } catch (error) {
      return failure(error)
    }
  }

  const verifyRoot: WorkState["verifyRoot"] = ({ turnId }) => {
    const published = authoritativeRoot({ turnId })
    return published !== null && published.root === manifestRoot(rebuild({ turnId }))
  }

  return {
    beginEffect,
    recordIdentity,
    recordResult,
    acknowledgeKey,
    isBlocked,
    rebuild,
    recover,
    publishRoot,
    authoritativeRoot,
    verifyRoot,
  }
}
