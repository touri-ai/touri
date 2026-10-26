import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createFileIoLane } from "../../src/kernel/file-io-client"
import { createWalCheckpointer } from "../../src/kernel/wal-checkpointer"
import { workerEntrypoint } from "../../src/kernel/worker-entrypoint"

const root = process.argv[2]
if (!root) throw new Error("Missing fixture directory")

const lane = createFileIoLane({
  createWorker: () =>
    new Worker(workerEntrypoint(new URL("./nested-helper.worker.ts", import.meta.url), "./nested-helper.worker.ts"), {
      smol: true,
      ref: false,
    }),
})
const start = async () => {
  await lane.run({
    operation: "append-log",
    args: {
      root,
      path: join(root, "first.log"),
      content: Buffer.from("first native log write\n"),
      maxBytes: 1024,
      retainedGenerations: 1,
    },
  })
  await lane.close()
  await checkpointer.dispose({ closing: true })
  database.close()
  process.stdout.write("first native log write persisted\n")
}
const fail = async () => {
  await lane.close()
  await checkpointer.dispose({ closing: true })
  database.close()
  process.stderr.write("First native log write failed\n")
  process.exitCode = 1
}
const database = new Database(join(root, "fixture.db"))
database.exec("PRAGMA journal_mode = WAL")
const checkpointer = createWalCheckpointer({
  database,
  onReady: () => void start().catch(fail),
  onError: () => void fail(),
})
