import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openAuthStore } from "../../src/cli/auth/store"

const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test.each(["error", "close"] as const)(
  "an auth writer %s restarts before rotation, pairing and revocation",
  async (event) => {
    const root = await mkdtemp(join(tmpdir(), "touri-auth-recovery-"))
    cleanups.add(() => rm(root, { recursive: true, force: true }))
    const writer = new URL("../../src/cli/auth/store-writer.ts", import.meta.url).href
    const source = `import ${JSON.stringify(writer)};
self.addEventListener("message", ({ data }) => { if (data.type === "fixture-crash") { ${event === "close" ? "self.close()" : 'throw new Error("synthetic writer crash")'} } });`
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }))
    cleanups.add(async () => URL.revokeObjectURL(url))
    const workers: Worker[] = []
    const crash = Promise.withResolvers<void>()
    const store = await openAuthStore({
      filename: join(root, "auth.db"),
      createWriterWorker: () => {
        const worker = new Worker(url)
        worker.addEventListener(event, () => crash.resolve(), { once: true })
        workers.push(worker)
        return worker
      },
    })
    cleanups.add(() => store.close())
    const claimed = await store.claimPairingCode({
      code: (await store.createPairingCode()).code,
      deviceName: "Synthetic device",
    })
    if (!claimed.success) throw new Error("Synthetic pairing failed")
    const [first] = workers
    if (!first) throw new Error("Synthetic writer missing")

    first.postMessage({ type: "fixture-crash" })
    await crash.promise
    const rotated = await store.rotateDeviceToken(claimed.token)
    const code = await store.createPairingCode()
    const revoked = await store.revokeDevice(claimed.device.id)

    expect(workers).toHaveLength(2)
    expect(rotated?.device.id).toBe(claimed.device.id)
    expect(code.success).toBe(true)
    expect(revoked.success).toBe(true)
    expect(store.verifyDeviceToken(rotated?.token ?? "")).toBeNull()
    expect(store.verifyDeviceToken(claimed.token)).toBeNull()
  },
  20_000,
)
