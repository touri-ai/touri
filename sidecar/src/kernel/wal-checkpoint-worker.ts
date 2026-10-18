import { Database, constants as sqliteFlags } from "bun:sqlite"

type Start = { type: "start"; filename: string; intervalMs: number }
type Stop = { type: "stop" }
type Message = Start | Stop

let database: Database | undefined
let timer: ReturnType<typeof setInterval> | undefined

const isBusyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  error.code.startsWith("SQLITE_BUSY")

const checkpoint = (): void => {
  if (!database) return
  try {
    database.query("PRAGMA wal_checkpoint(PASSIVE)").get()
  } catch (error) {
    if (!isBusyError(error)) self.postMessage({ type: "error" })
  }
}

self.onmessage = ({ data }: MessageEvent<Message>): void => {
  if (data.type === "stop") {
    clearInterval(timer)
    database?.close()
    database = undefined
    self.postMessage({ type: "stopped" })
    return
  }

  try {
    database = new Database(data.filename, sqliteFlags.SQLITE_OPEN_READWRITE | sqliteFlags.SQLITE_OPEN_NOFOLLOW)
    database.exec("PRAGMA busy_timeout = 0; PRAGMA wal_autocheckpoint = 0")
    timer = setInterval(checkpoint, data.intervalMs)
  } catch {
    self.postMessage({ type: "error" })
  }
}
