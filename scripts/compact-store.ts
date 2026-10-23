import { constants, Database } from "bun:sqlite"
import { open, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

/** One-shot operator command. Never invoked by a request handler or turn. */
export const prepareCompactedStore = async (filename: string, destination: string): Promise<void> => {
  const sourcePath = await realpath(filename)
  const requestedPath = resolve(destination)
  const targetRoot = await realpath(dirname(requestedPath))
  const targetPath = resolve(targetRoot, basename(requestedPath))
  if (sourcePath === targetPath) throw new Error("INVALID_DESTINATION")

  // Exclusive creation reserves an operator-selected private destination without overwriting a backup.
  const reservation = await open(targetPath, "wx", 0o600)
  await reservation.close()
  const pendingPath = `${targetPath}.pending`
  const pending = await open(pendingPath, "wx", 0o600).catch(async (error: unknown) => {
    await rm(targetPath)
    throw error
  })
  await pending.close()
  let source: Database | undefined
  try {
    source = new Database(sourcePath, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW)
    // VACUUM INTO holds a WAL read snapshot, permits live writers and never swaps the source.
    // On an existing non-incremental store this setting is connection-local until a rebuild;
    // only the output is rebuilt. Run this CLI in a separate process, never on the server loop.
    source.exec("PRAGMA busy_timeout = 1000; PRAGMA auto_vacuum = INCREMENTAL")
    source.query("VACUUM INTO ?").run(pendingPath)
    const compacted = new Database(pendingPath, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW)
    try {
      const integrity = compacted.query("PRAGMA integrity_check").get() as { integrity_check: string }
      const mode = compacted.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
      if (integrity.integrity_check !== "ok") throw new Error("COMPACTED_STORE_INVALID")
      if (mode.auto_vacuum !== 2) throw new Error("COMPACTED_STORE_MODE")
      compacted.exec("PRAGMA journal_mode = DELETE")
    } finally {
      compacted.close()
    }
    const durable = await open(pendingPath, "r+")
    await durable.sync()
    await durable.close()
    await rename(pendingPath, targetPath)
    if (process.platform !== "win32") {
      const directory = await open(targetRoot, "r")
      await directory.sync()
      await directory.close()
    }
  } catch (error) {
    await rm(pendingPath, { force: true })
    await rm(targetPath, { force: true })
    throw error
  } finally {
    source?.close()
  }
}

const runCompaction = async (): Promise<void> => {
  const [filename, destination] = process.argv.slice(2)
  if (!filename || !destination) {
    process.stderr.write("STORE_COMPACTION_INVALID_ARGS\n")
    process.exitCode = 2
    return
  }

  try {
    await prepareCompactedStore(filename, destination)
    const { size } = await stat(destination)
    console.info(JSON.stringify({ compactedBytes: size, sourceReplaced: false, autoVacuum: "incremental" }))
  } catch {
    process.stderr.write("STORE_COMPACTION_FAILED\n")
    process.exitCode = 1
  }
}

if (import.meta.main) await runCompaction()
