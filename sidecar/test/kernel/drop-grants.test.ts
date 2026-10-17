import { afterEach, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { init } from "../../src/store"
import { redeemFileGrant } from "../../src/store/redeemFileGrant"

type Redeemed = { path: string; dev: string; ino: string; size: number }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const grantFor = (path: string): Redeemed => {
  const info = statSync(path, { bigint: true })
  return { path, dev: String(info.dev), ino: String(info.ino), size: Number(info.size) }
}

const fixture = async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-drop-grants-")))
  const runtime = createKernel({ appData: join(root, "app") })
  await init(runtime.kernel)
  const live = new Map<string, Redeemed>()
  const redeemCalls: Array<string> = []
  const callHost = (async (method: string, params: { grantId?: string }) => {
    redeemCalls.push(String(params.grantId))
    const grant = live.get(String(params.grantId))
    if (method !== "file.grant.redeem" || !grant) return { success: false, errorCode: "HOST_ERROR", error: "unknown" }
    live.delete(String(params.grantId))
    return { success: true, value: grant }
  }) as Kernel["callHost"]
  runtime.kernel.callHost = callHost
  cleanups.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const issue = (grant: Redeemed): string => {
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
    live.set(id, grant)
    return id
  }
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/attachments`, {
      method: "POST",
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
  return { root, runtime, issue, post, redeemCalls, callHost }
}

test("drop grant: a shell grant creates an attachment from the exact file and is single-use", async () => {
  const f = await fixture()
  const file = join(f.root, "nota.txt")
  writeFileSync(file, "conteudo")
  const id = f.issue(grantFor(file))
  const first = await f.post({ grantId: id })
  expect(first.status).toBe(201)
  expect(((await first.json()) as { attachment: { bytes: number } }).attachment.bytes).toBe(8)
  const replay = await f.post({ grantId: id })
  expect(replay.status).toBe(403)
  expect(((await replay.json()) as { errorCode: string }).errorCode).toBe("FILE_GRANT_REQUIRED")
})

test("drop grant: forged ids, raw paths and a missing host are refused", async () => {
  const f = await fixture()
  const file = join(f.root, "secret.txt")
  writeFileSync(file, "x")
  expect((await f.post({ grantId: "forged" })).status).toBe(403)
  expect((await f.post({ grantId: "a".repeat(64) })).status).toBe(403)
  expect((await f.post({ grantId: { path: file } })).status).toBe(403)
  expect((await f.post({ path: file })).status).toBe(403)
  expect((await f.post({ grantId: "a".repeat(64), path: file })).status).toBe(403)
})

test("drop grant: without a host bridge no grant can be redeemed", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-drop-nohost-"))
  const runtime = createKernel({ appData: root })
  cleanups.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const result = await redeemFileGrant({
    kernel: runtime.kernel,
    grantId: "b".repeat(64),
    signal: new AbortController().signal,
  })
  expect(result.success).toBe(false)
})

test("drop grant: a grant is bound to the exact path, device and inode the shell pinned", async () => {
  const f = await fixture()
  const file = join(f.root, "a.txt")
  const other = join(f.root, "b.txt")
  writeFileSync(file, "a")
  writeFileSync(other, "b")
  const pinned = grantFor(file)
  const swapped = await f.post({ grantId: f.issue({ ...pinned, path: other }) })
  expect(swapped.status).toBe(400)
  // Keep the pinned inode alive: unlink/recreate may immediately reuse it on Linux.
  renameSync(file, join(f.root, "original.txt"))
  writeFileSync(file, "replacement")
  expect(grantFor(file).ino).not.toBe(pinned.ino)
  expect((await f.post({ grantId: f.issue(pinned) })).status).toBe(400)
})

test("drop grant: symlink leaves, symlinked ancestors, directories and oversized files are rejected", async () => {
  const f = await fixture()
  const real = join(f.root, "real")
  mkdirSync(real)
  const file = join(real, "x.txt")
  writeFileSync(file, "x")
  const link = join(f.root, "link.txt")
  symlinkSync(file, link)
  const linkedDir = join(f.root, "linkdir")
  symlinkSync(real, linkedDir)
  const big = join(f.root, "big.bin")
  writeFileSync(big, "")
  truncateSync(big, 15 * 1024 * 1024 + 1)
  expect((await f.post({ grantId: f.issue(grantFor(link)) })).status).toBe(400)
  expect((await f.post({ grantId: f.issue({ ...grantFor(file), path: join(linkedDir, "x.txt") }) })).status).toBe(400)
  expect((await f.post({ grantId: f.issue(grantFor(real)) })).status).toBe(400)
  expect((await f.post({ grantId: f.issue(grantFor(big)) })).status).toBe(400)
  expect((await f.post({ grantId: f.issue({ ...grantFor(file), path: "relative/x.txt" }) })).status).toBe(400)
  expect((await f.post({ grantId: f.issue({ ...grantFor(file), path: `${real}/../real/x.txt` }) })).status).toBe(400)
})

test("drop grant: another device or served session cannot redeem and never reaches the host", async () => {
  const f = await fixture()
  const file = join(f.root, "a.txt")
  writeFileSync(file, "a")
  const id = f.issue(grantFor(file))
  const signal = new AbortController().signal
  bindDeviceSession(signal, { deviceId: "browser-device", active: () => true })
  const result = await redeemFileGrant({ kernel: { callHost: f.callHost }, grantId: id, signal })
  expect(result).toMatchObject({ success: false, status: 403, errorCode: "FILE_GRANT_REQUIRED" })
  expect(f.redeemCalls).toHaveLength(0)
  expect((await f.post({ grantId: id })).status).toBe(201)
})
