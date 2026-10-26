import { join } from "node:path"
import { createFileIoLane } from "../../src/kernel/file-io-client"

const root = process.argv[2]
if (!root) throw new Error("Missing fixture directory")

const url = URL.createObjectURL(
  new Blob(['self.onmessage = () => self.postMessage("ready")'], { type: "application/javascript" }),
)
const trigger = new Worker(url)
const lane = createFileIoLane()
trigger.onmessage = async () => {
  await lane.run({ operation: "append", args: { root, path: join(root, "log"), content: "worker reply persisted\n" } })
  await lane.close()
  trigger.terminate()
  URL.revokeObjectURL(url)
  process.stdout.write("worker reply persisted\n")
}
trigger.postMessage("start")
