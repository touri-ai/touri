import type { Database } from "bun:sqlite"
import { attachmentReferenceSource } from "./attachment-reference-worker"
import { attachmentReferences } from "./output-blobs"
import type { PerformanceStageRunner } from "./performance"

export class AttachmentReferenceScanDeferred extends Error {}

export const createAttachmentReferenceScan = (
  database: Database,
  runStage?: PerformanceStageRunner,
  signal?: AbortSignal,
  yieldBatch: () => Promise<void> = () => Bun.sleep(0),
  timeoutMs = 10 * 60_000,
) => {
  // Worker, deadline and one outstanding request belong to this collection pass.
  let worker: Worker | undefined
  let url: string | undefined
  let pending: { resolve: (ids: string[]) => void; reject: (error: Error) => void } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let referenced = new Set<string>()
  const dispose = () => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", fail)
    worker?.terminate()
    if (url) URL.revokeObjectURL(url)
  }
  const reject = (error: Error) => {
    pending?.reject(error)
    pending = undefined
    dispose()
  }
  const fail = () => reject(new Error("Attachment reference scan interrupted"))
  const defer = () => reject(new AttachmentReferenceScanDeferred("Attachment reference scan deferred"))
  const request = (message: { type: string; filename?: string; ids?: string[] }): Promise<string[]> =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject }
      // A cold large store may take minutes; a stalled worker must still be reclaimable.
      timer = setTimeout(defer, timeoutMs)
      worker?.postMessage(message)
    })
  const start = async () => {
    signal?.throwIfAborted()
    if (!database.filename || database.filename === ":memory:") {
      referenced = await getMemoryReferences(database, runStage, yieldBatch)
      return
    }

    url = URL.createObjectURL(new Blob([attachmentReferenceSource], { type: "application/javascript" }))
    worker = new Worker(url, { smol: true, ref: false })
    signal?.addEventListener("abort", fail, { once: true })
    worker.addEventListener("close", () => {
      if (pending) fail()
    })
    worker.onerror = (event) => {
      event.preventDefault()
      fail()
    }
    worker.onmessage = async ({ data }: MessageEvent<{ type: string; ids?: string[] }>) => {
      if (data.type === "error") return fail()
      if (data.type === "changed") return defer()
      if (data.type === "batch") {
        try {
          await yieldBatch()
          worker?.postMessage({ type: "continue" })
        } catch {
          fail()
        }
        return
      }

      clearTimeout(timer)
      pending?.resolve(data.ids ?? [])
      pending = undefined
    }
    const scan = () => request({ type: "scan", filename: database.filename })
    if (runStage) await runStage("storage_attachment_reference_scan", scan)
    else await scan()
  }
  const getUnreferenced = async (ids: string[]): Promise<Set<string>> => {
    if (worker) return new Set(await request({ type: "candidates", ids }))

    return new Set(ids.filter((id) => !referenced.has(id)))
  }

  return { start, getUnreferenced, dispose }
}

// In-memory fixtures have no independent connection. Scan once per pass rather
// than rescanning history for every candidate page; file-backed stores use workers.
const getMemoryReferences = async (
  database: Database,
  runStage: PerformanceStageRunner | undefined,
  yieldBatch: () => Promise<void>,
) => {
  const referenced = new Set<string>()
  for (const [table, key, column] of [
    ["messages", "rowid", "parts_json"],
    ["tool_resolutions", "rowid", "part_json"],
    ["transcript_entries", "id", "event_json"],
    ["ui_event_log", "seq", "event_json"],
    ["send_journal", "rowid", "request_json"],
  ]) {
    let cursor = 0
    while (true) {
      const scan = () =>
        database
          .query(`SELECT ${key} AS cursor, ${column} AS json FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT 1`)
          .get(cursor) as { cursor: number; json: string } | null
      const row = runStage ? runStage("storage_attachment_reference_scan", scan) : scan()
      if (!row) break

      attachmentReferences(JSON.parse(row.json), referenced)
      cursor = row.cursor
      await yieldBatch()
    }
  }
  return referenced
}
