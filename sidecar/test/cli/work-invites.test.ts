import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActionLimiter } from "../../src/cli/auth/rateLimit"
import { openAuthStore } from "../../src/cli/auth/store"

const directories = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(directories, (directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "touri-work-invites-"))
  directories.add(directory)
  return directory
}

test("existing devices migrate to the first admin person", async () => {
  const directory = await makeDirectory()
  const filename = join(directory, "auth.db")
  const token = "legacy-device-token.1700000000000"
  const database = new Database(filename)
  database.exec(`
    CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
  `)
  database
    .query("INSERT INTO devices VALUES(?,?,?,?,?,NULL)")
    .run(
      "legacy-device",
      "Owner laptop",
      createHash("sha256").update(token).digest("hex"),
      1_700_000_000_000,
      1_700_000_000_000,
    )
  database.close()

  const store = await openAuthStore({ filename, now: () => 1_700_000_000_000 })
  try {
    expect(store.getPerson("owner")).toMatchObject({ id: "owner", role: "admin", removedAt: null })
    expect(store.verifyDeviceToken(token)).toMatchObject({ id: "legacy-device", personId: "owner" })
    expect(store.listDevices()).toContainEqual(expect.objectContaining({ id: "legacy-device", personId: "owner" }))
  } finally {
    await store.close()
  }
})

test("invite tokens are hashed, email-bound, single-use, reschedulable and revoke all devices on removal", async () => {
  const directory = await makeDirectory()
  const filename = join(directory, "auth.db")
  const now = 1_800_000_000_000
  const store = await openAuthStore({ filename, now: () => now })
  try {
    const created = await store.createInvite({
      actorPersonId: "owner",
      name: "Ana",
      email: " ANA@example.com ",
      role: "member",
      channelIds: ["channel-a"],
    })
    if (!created.success) throw new Error("Invite creation failed")
    expect(created.invite.email).toBe("ana@example.com")
    expect(created.invite.expiresAt - created.invite.createdAt).toBe(24 * 60 * 60_000)

    const stored = new Database(filename)
    const tokenHash = (
      stored.query("SELECT token_hash FROM invites WHERE id = ?").get(created.invite.id) as {
        token_hash: string
      }
    ).token_hash
    stored.close()
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(tokenHash).not.toBe(created.token)

    expect(
      await store.claimInvite({ token: created.token, email: "other@example.com", deviceName: "Browser" }),
    ).toMatchObject({
      success: false,
    })
    const claimed = await store.claimInvite({ token: created.token, email: "ANA@example.com", deviceName: "Browser" })
    if (!claimed.success) throw new Error("Invite redemption failed")
    expect(claimed.person).toMatchObject({ name: "Ana", email: "ana@example.com", role: "member" })
    expect(claimed.device.personId).toBe(claimed.person.id)
    expect(store.getPersonChannelIds(claimed.person.id)).toEqual(["channel-a"])
    expect(
      await store.claimInvite({ token: created.token, email: "ana@example.com", deviceName: "Second browser" }),
    ).toMatchObject({
      success: false,
    })

    const invitation = await store.createInvite({
      actorPersonId: "owner",
      name: "Bia",
      email: "bia@example.com",
      role: "member",
      channelIds: [],
    })
    if (!invitation.success) throw new Error("Second invite creation failed")
    const resent = await store.resendInvite({ id: invitation.invite.id, actorPersonId: "owner" })
    if (!resent.success) throw new Error("Invite resend failed")
    expect(
      await store.claimInvite({ token: invitation.token, email: "bia@example.com", deviceName: "Browser" }),
    ).toMatchObject({
      success: false,
    })
    const accepted = await store.claimInvite({ token: resent.token, email: "bia@example.com", deviceName: "Browser" })
    if (!accepted.success) throw new Error("Resent invite redemption failed")

    const duplicate = await store.createInvite({
      actorPersonId: "owner",
      name: "Bia",
      email: "bia@example.com",
      role: "member",
      channelIds: [],
    })
    expect(duplicate.success).toBe(false)

    const secondDeviceToken = "second-bia-device.1800000000000"
    const writer = new Database(filename)
    writer
      .query("INSERT INTO devices(id,name,token_hash,created_at,last_seen_at,person_id) VALUES(?,?,?,?,?,?)")
      .run(
        "bia-second-device",
        "Second device",
        createHash("sha256").update(secondDeviceToken).digest("hex"),
        now,
        now,
        accepted.person.id,
      )
    writer.close()
    expect(await store.removePerson({ id: accepted.person.id, actorPersonId: "owner" })).toMatchObject({
      success: true,
    })
    expect(store.getPerson(accepted.person.id)).toBeNull()
    expect(store.verifyDeviceToken(accepted.token)).toBeNull()
    expect(store.verifyDeviceToken(secondDeviceToken)).toBeNull()
    expect(
      store
        .listDevices()
        .filter((device) => device.personId === accepted.person.id)
        .every((device) => device.revokedAt !== null),
    ).toBe(true)

    const revocable = await store.createInvite({
      actorPersonId: "owner",
      name: "Ivo",
      email: "ivo@example.com",
      role: "member",
      channelIds: [],
    })
    if (!revocable.success) throw new Error("Revocable invite creation failed")
    expect(await store.revokeInvite({ id: revocable.invite.id, actorPersonId: "owner" })).toMatchObject({
      success: true,
    })
    expect(
      await store.claimInvite({ token: revocable.token, email: "ivo@example.com", deviceName: "Browser" }),
    ).toMatchObject({
      success: false,
    })
  } finally {
    await store.close()
  }
})

test("expired invites and admin-only writes are rejected", async () => {
  const directory = await makeDirectory()
  const filename = join(directory, "auth.db")
  let now = 1_900_000_000_000
  const store = await openAuthStore({ filename, now: () => now })
  try {
    const created = await store.createInvite({
      actorPersonId: "owner",
      name: "Caio",
      email: "caio@example.com",
      role: "admin",
      channelIds: [],
    })
    if (!created.success) throw new Error("Invite creation failed")
    now += 24 * 60 * 60_000
    expect(
      await store.claimInvite({ token: created.token, email: "caio@example.com", deviceName: "Browser" }),
    ).toMatchObject({
      success: false,
    })
    expect(
      await store.createInvite({
        actorPersonId: "non-admin",
        name: "Dani",
        email: "dani@example.com",
        role: "admin",
        channelIds: [],
      }),
    ).toMatchObject({ success: false })
    expect(await store.saveEmailConfig({ actorPersonId: "non-admin", config: { transport: "smtp" } })).toBe(false)
    expect(await store.removePerson({ id: "owner", actorPersonId: "non-admin" })).toMatchObject({ success: false })
  } finally {
    await store.close()
  }
})

test("successful admin actions share a bounded per-person rate window", () => {
  let now = 1000
  const limiter = createActionLimiter({ maxActions: 2, windowMs: 60_000, now: () => now })
  expect(limiter.check("owner")).toEqual({ allowed: true })
  limiter.record("owner")
  limiter.record("owner")
  expect(limiter.check("owner").allowed).toBe(false)
  expect(limiter.check("another-admin").allowed).toBe(true)
  now += 60_001
  expect(limiter.check("owner")).toEqual({ allowed: true })
})
