import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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

test("trusted sign-in seeks the active email index and persists only the device token hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-proxy-store-"))
  cleanups.add(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, "auth.db")
  const store = await openAuthStore({ filename })
  cleanups.add(() => store.close())
  const database = new Database(filename)
  cleanups.add(async () => database.close())
  // The server is stopped while this disposable fixture seeds a larger synthetic team.
  database.exec(`
    WITH RECURSIVE members(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM members WHERE n < 5000)
    INSERT INTO people(id,name,email,avatar_seed,role,created_at)
    SELECT 'member-' || n, 'Synthetic member', 'member-' || n || '@example.test', 'demo', 'member', 1 FROM members
  `)
  const email = "member-5000@example.test"

  const plan = database
    .query("EXPLAIN QUERY PLAN SELECT * FROM people WHERE email = ? AND removed_at IS NULL LIMIT 1")
    .all(email) as Array<{ detail: string }>
  const result = await store.signInTrustedEmail({ email, deviceName: "Synthetic browser" })

  expect(plan.some(({ detail }) => detail.includes("SEARCH people USING INDEX people_email_active"))).toBe(true)
  expect(result.success).toBe(true)
  if (!result.success) throw new Error("Synthetic sign-in failed")
  expect(result.person.id).toBe("member-5000")
  expect(result.person.role).toBe("member")
  expect(store.verifyDeviceToken(result.token)?.personId).toBe("member-5000")
  expect(database.query("SELECT token_hash FROM devices WHERE id = ?").get(result.device.id)).toEqual({
    token_hash: createHash("sha256").update(result.token).digest("hex"),
  })
})
