import { listen } from "@tauri-apps/api/event"
import { type TranslationKey, t } from "./i18n"

export const fileDragEvent = "touri://file-drag"
export const fileDropEvent = "touri://file-drop"

export type DropRejectReason = "directory" | "symlink" | "too_large" | "unsupported" | "unreadable" | "too_many"
export type GrantedDrop = { id: string; name: string }
export type RejectedDrop = { name: string; reason: DropRejectReason }
export type FileDrop = { granted: Array<GrantedDrop>; rejected: Array<RejectedDrop> }

const GRANT_ID = /^[a-f0-9]{64}$/
const REASONS: ReadonlyArray<DropRejectReason> = [
  "directory",
  "symlink",
  "too_large",
  "unsupported",
  "unreadable",
  "too_many",
]

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

const asGranted = (value: unknown): Array<GrantedDrop> =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const entry = record(item)
    if (!entry || typeof entry.id !== "string" || !GRANT_ID.test(entry.id) || typeof entry.name !== "string") return []
    return [{ id: entry.id, name: entry.name }]
  })

const asRejected = (value: unknown): Array<RejectedDrop> =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const entry = record(item)
    const reason = REASONS.find((candidate) => candidate === entry?.reason)
    if (!entry || typeof entry.name !== "string" || !reason) return []
    return [{ name: entry.name, reason }]
  })

/** Only grant ids and display names cross from the shell; anything else in the payload is dropped. */
export const parseFileDrop = (payload: unknown): FileDrop => {
  const data = record(payload)
  return { granted: asGranted(data?.granted), rejected: asRejected(data?.rejected) }
}

const rejectionText: Record<DropRejectReason, TranslationKey> = {
  directory: "é uma pasta. Solte arquivos, não pastas.",
  symlink: "é um atalho (link simbólico). Solte o arquivo original.",
  too_large: "tem mais de 15 MB.",
  unsupported: "não é um arquivo comum e não pode ser anexado.",
  unreadable: "não pôde ser lido.",
  too_many: "passou do limite de arquivos por vez.",
}

export const dropRejectionMessage = ({ name, reason }: RejectedDrop): string =>
  t("Não foi possível anexar {name}: {reason}", { name, reason: t(rejectionText[reason]) })

export type FileDropHandlers = { onActive: (active: boolean) => void; onDrop: (drop: FileDrop) => void }

/** Subscribes to the shell's native drag-and-drop events. Returns an unsubscribe function. */
export const listenForFileDrops = ({ onActive, onDrop }: FileDropHandlers): (() => void) => {
  let disposed = false
  const stops: Array<() => void> = []
  const keep = (stop: () => void): void => {
    if (disposed) stop()
    else stops.push(stop)
  }
  void listen(fileDragEvent, (event) => onActive(record(event.payload)?.active === true))
    .then(keep)
    .catch(() => undefined)
  void listen(fileDropEvent, (event) => onDrop(parseFileDrop(event.payload)))
    .then(keep)
    .catch(() => undefined)
  return () => {
    disposed = true
    for (const stop of stops.splice(0)) stop()
  }
}
