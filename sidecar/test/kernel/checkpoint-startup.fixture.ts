import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createWalCheckpointer } from "../../src/kernel/wal-checkpointer"

const root = process.argv[2]
if (!root) throw new Error("Missing fixture directory")

const database = new Database(join(root, "fixture.db"))
database.exec("PRAGMA journal_mode = WAL")
const ready = Promise.withResolvers<void>()
const checkpointer = createWalCheckpointer({
  database,
  onReady: ready.resolve,
  onError: () => ready.reject(new Error("Checkpoint worker failed")),
})

// A top-level await would keep the process alive and hide missing worker references.
void ready.promise.then(async () => {
  await checkpointer.dispose({ closing: true })
  database.close()
  process.stdout.write("checkpoint worker started and stopped\n")
})
