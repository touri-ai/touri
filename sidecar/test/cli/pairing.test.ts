import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRateLimiter } from "../../src/cli/auth/rateLimit"
import { normalizeCode, openAuthStore, pairingCodeTtlMs } from "../../src/cli/auth/store"

const openStore = async (clock: { now: number }) =>
  openAuthStore({ filename: join(mkdtempSync(join(tmpdir(), "touri-auth-")), "auth.db"), now: () => clock.now })

test("codes look like XXXX-XXXX-XXXX and normalize tolerant of case and separators", async () => {
  const store = await openStore({ now: 1000 })
  const { code } = await store.createPairingCode()
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  expect(normalizeCode(code.toLowerCase())).toBe(code.replaceAll("-", ""))
  await store.close()
})

test("a code works once and then is spent", async () => {
  const store = await openStore({ now: 1000 })
  const { code } = await store.createPairingCode()
  const first = await store.claimPairingCode({ code, deviceName: "Laptop" })
  expect(first.success).toBe(true)
  const second = await store.claimPairingCode({ code, deviceName: "Phone" })
  expect(second).toMatchObject({ success: false, errorCode: "INVALID_CODE" })
  expect(store.listDevices()).toHaveLength(1)
  await store.close()
})

test("a code expires after five minutes", async () => {
  const clock = { now: 1_000_000 }
  const store = await openStore(clock)
  const fresh = await store.createPairingCode()
  expect(fresh.expiresAt).toBe(1_000_000 + pairingCodeTtlMs)
  clock.now += pairingCodeTtlMs - 1
  expect((await store.claimPairingCode({ code: fresh.code, deviceName: "ok" })).success).toBe(true)
  const stale = await store.createPairingCode()
  clock.now += pairingCodeTtlMs
  expect((await store.claimPairingCode({ code: stale.code, deviceName: "late" })).success).toBe(false)
  await store.close()
})

test("wrong and malformed codes are rejected without creating devices", async () => {
  const store = await openStore({ now: 5 })
  await store.createPairingCode()
  expect((await store.claimPairingCode({ code: "AAAA-AAAA-AAAA", deviceName: "x" })).success).toBe(false)
  expect((await store.claimPairingCode({ code: "", deviceName: "x" })).success).toBe(false)
  expect((await store.claimPairingCode({ code: "ABC", deviceName: "x" })).success).toBe(false)
  expect(store.listDevices()).toHaveLength(0)
  await store.close()
})

test("device tokens verify, are stored hashed, and stop working after revoke", async () => {
  const store = await openStore({ now: 10 })
  const claimed = await store.claimPairingCode({ code: (await store.createPairingCode()).code, deviceName: "Mac" })
  if (!claimed.success) throw new Error("claim failed")
  expect(store.verifyDeviceToken(claimed.token)?.id).toBe(claimed.device.id)
  expect(store.verifyDeviceToken("nope")).toBeNull()
  const revoked = await store.revokeDevice(claimed.device.id.slice(0, 4))
  expect(revoked.success).toBe(true)
  expect(store.verifyDeviceToken(claimed.token)).toBeNull()
  expect((await store.revokeDevice(claimed.device.id)).success).toBe(false)
  await store.close()
})

test("two connections to the same file see each other's codes (CLI and server)", async () => {
  const filename = join(mkdtempSync(join(tmpdir(), "touri-auth-")), "auth.db")
  const cli = await openAuthStore({ filename })
  const server = await openAuthStore({ filename })
  const { code } = await cli.createPairingCode()
  expect((await server.claimPairingCode({ code, deviceName: "browser" })).success).toBe(true)
  expect(cli.listDevices()).toHaveLength(1)
  await cli.close()
  await server.close()
})

test("the rate limiter blocks after repeated failures and recovers after the window", async () => {
  const clock = { now: 0 }
  const limiter = createRateLimiter({ maxFailures: 2, windowMs: 1000, now: () => clock.now })
  expect(limiter.check().allowed).toBe(true)
  limiter.recordFailure()
  limiter.recordFailure()
  expect(limiter.check()).toMatchObject({ allowed: false, retryAfterSeconds: 1 })
  clock.now = 1001
  expect(limiter.check().allowed).toBe(true)
})

test("A06: device tokens expire server-side even if the browser retains its cookie", async () => {
  const clock = { now: 1_000_000 }
  const store = await openStore(clock)
  try {
    const claimed = await store.claimPairingCode({ code: (await store.createPairingCode()).code, deviceName: "test" })
    if (!claimed.success) throw new Error("pair failed")
    clock.now += 31 * 24 * 60 * 60_000
    expect(store.verifyDeviceToken(claimed.token)).toBeNull()
  } finally {
    await store.close()
  }
})

test("A06: rotation invalidates the old token across CLI connections and renews expiry", async () => {
  const clock = { now: 1_000_000 }
  const filename = join(mkdtempSync(join(tmpdir(), "touri-auth-")), "auth.db")
  const store = await openAuthStore({ filename, now: () => clock.now })
  const cli = await openAuthStore({ filename, now: () => clock.now })
  try {
    const claimed = await store.claimPairingCode({ code: (await store.createPairingCode()).code, deviceName: "test" })
    if (!claimed.success) throw new Error("pair failed")
    clock.now += 20 * 24 * 60 * 60_000
    const rotated = await store.rotateDeviceToken(claimed.token)
    expect(rotated?.device.id).toBe(claimed.device.id)
    expect(cli.verifyDeviceToken(claimed.token)).toBeNull()
    expect(await store.rotateDeviceToken(claimed.token)).toBeNull()
    clock.now += 20 * 24 * 60 * 60_000
    expect(cli.verifyDeviceToken(rotated?.token ?? "")?.id).toBe(claimed.device.id)
    await cli.revokeDevice(claimed.device.id)
    expect(store.verifyDeviceToken(rotated?.token ?? "")).toBeNull()
  } finally {
    await store.close()
    await cli.close()
  }
})

test("R11-REG-07: a device used at least monthly never has to re-pair, an idle one still expires", async () => {
  const day = 24 * 60 * 60_000
  const clock = { now: 1_000_000 }
  const store = await openStore(clock)
  try {
    const claimed = await store.claimPairingCode({ code: (await store.createPairingCode()).code, deviceName: "test" })
    if (!claimed.success) throw new Error("pair failed")
    for (let visit = 0; visit < 6; visit++) {
      clock.now += 20 * day
      expect(store.verifyDeviceToken(claimed.token)?.id).toBe(claimed.device.id)
    }
    clock.now += 31 * day
    expect(store.verifyDeviceToken(claimed.token)).toBeNull()
  } finally {
    await store.close()
  }
})
