import type { Database } from "bun:sqlite"
import { lstat, realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type RetentionProcess = Bun.Subprocess<"pipe", "pipe", "ignore">
type RetentionResult = { more: boolean; cursor: number }
type RetentionOwner = { run: (manual?: boolean) => Promise<boolean>; dispose: () => Promise<void> }

// Connection-scoped lifecycle registry: both maintenance callers share one writer and no waiting list.
const owners = new WeakMap<Database, ReturnType<typeof createRetentionOwner>>()

export const createTranscriptRetention = (database: Database): RetentionOwner => {
  const owner = owners.get(database) ?? createRetentionOwner(database.filename)
  owners.set(database, owner)
  const release = owner.acquire()

  return { run: owner.run, dispose: release }
}

const createRetentionOwner = (filename: string) => {
  // Only this connection's cursors, child handle and owner count change during maintenance.
  let references = 0
  let cursor = 0
  let child: RetentionProcess | undefined
  let running: Promise<boolean> | undefined
  const run = (manual = false): Promise<boolean> => {
    if (!references) return Promise.resolve(false)
    if (running) return running.then(() => true)

    running = runBatch(manual).finally(() => {
      running = undefined
    })
    return running
  }
  const runBatch = async (manual: boolean): Promise<boolean> => {
    const { path, dev, ino } = await getDatabaseIdentity(filename)
    if (!references) return false

    const source = fileURLToPath(new URL("./transcript-retention-process.ts", import.meta.url))
    const args = Bun.isStandaloneExecutable ? [] : ["--no-env-file", source]
    const processHandle = Bun.spawn([process.execPath, ...args, "transcript-retention"], {
      cwd: dirname(path),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { TOURI_APP_DATA: dirname(path) },
    })
    child = processHandle
    const timer = setTimeout(() => processHandle.kill("SIGKILL"), 15_000)
    try {
      processHandle.stdin.write(JSON.stringify({ filename: path, dev, ino, cursor, manual }))
      await processHandle.stdin.end()
      const [reply, code] = await Promise.all([
        getRetentionReply(processHandle.stdout).catch(() => undefined),
        processHandle.exited,
      ])
      if (!references) return false
      // A watchdog interruption rolls back the whole batch; retry its unchanged cursor.
      if (code === 75 || processHandle.signalCode === "SIGKILL") return true
      if (code !== 0) throw new Error("RETENTION_FAILED")
      if (!reply) throw new Error("RETENTION_FAILED")
      cursor = reply.cursor
      return reply.more
    } catch {
      processHandle.kill("SIGKILL")
      await processHandle.exited
      if (!references) return false
      throw new Error("RETENTION_FAILED")
    } finally {
      clearTimeout(timer)
      child = undefined
    }
  }

  return {
    run,
    acquire: (): (() => Promise<void>) => {
      references += 1
      let released = false
      return async () => {
        if (released) return
        released = true
        references -= 1
        if (references) return

        if (!child) return
        child.kill("SIGKILL")
        await running?.catch(() => {})
      }
    },
  }
}

const getDatabaseIdentity = async (filename: string): Promise<{ path: string; dev: number; ino: number }> => {
  try {
    const path = resolve(filename)
    const [canonical, stat] = await Promise.all([realpath(path), lstat(path)])
    if (canonical !== path || !stat.isFile() || stat.isSymbolicLink()) throw new Error("RETENTION_FAILED")

    return { path, dev: stat.dev, ino: stat.ino }
  } catch {
    throw new Error("RETENTION_FAILED")
  }
}

const getRetentionReply = async (stdout: ReadableStream<Uint8Array>): Promise<RetentionResult> => {
  const reader = stdout.getReader()
  let reply = ""
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    if (reply.length + next.value.byteLength > 256) throw new Error("RETENTION_FAILED")
    reply += new TextDecoder().decode(next.value)
  }
  // No stored text, SQL, paths or subprocess diagnostics cross this private boundary.
  if (!/^\{"more":(true|false),"cursor":\d+\}\n$/.test(reply)) throw new Error("RETENTION_FAILED")
  const result = JSON.parse(reply) as RetentionResult
  if (!Number.isSafeInteger(result.cursor)) throw new Error("RETENTION_FAILED")
  return result
}
