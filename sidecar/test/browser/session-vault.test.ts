import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { botSessionPath, loadBotSession, SessionVaultError, saveBotSession } from "../../src/browser/sessionVault"
import { createAppPaths } from "../../src/kernel/paths"

const session = {
  cookies: [{ name: "session", value: "synthetic-cookie", domain: "example.test", path: "/" }],
  storage: { "https://example.test": { token: "synthetic-storage" } },
}
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-session-vault-"))
  const keys = new Map<string, string>()
  const writes: string[] = []
  let failure: string | null = null
  const kernel = {
    paths: createAppPaths({ appData: root }),
    callHost: async (method: string, input: { account: string; value?: string }) => {
      if (failure === "throw") throw new Error("synthetic transport failure")
      if (failure === "hang") return new Promise(() => {})
      if (failure) return { success: false, errorCode: failure, error: "synthetic vault failure" }
      if (method === "keychain.set") {
        writes.push(input.account)
        keys.set(input.account, input.value ?? "")
      }
      return { success: true, value: { value: keys.get(input.account) ?? null } }
    },
  } as unknown as Kernel
  return {
    kernel,
    keys,
    writes,
    path: botSessionPath(kernel, "saved"),
    fail: (value: string | null) => {
      failure = value
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

for (const failure of ["VAULT_ACCESS_REQUIRED", "VAULT_TIMEOUT", "VAULT_CANCELLED", "HOST_UNAVAILABLE", "throw"])
  test(`${failure}: unreadable sessions remain unknown and ciphertext is untouched on save`, async () => {
    const f = fixture()
    try {
      expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session })).toBe(true)
      const before = readFileSync(f.path)
      expect(JSON.parse(before.toString()).enc).toBe("aes-256-gcm")
      const writes = f.writes.length
      f.fail(failure)
      const error = await loadBotSession(f.kernel, "saved").catch((error: unknown) => error)
      expect(error).toBeInstanceOf(SessionVaultError)
      expect((error as SessionVaultError).errorCode).toBe(failure === "throw" ? "VAULT_UNAVAILABLE" : failure)
      expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session: { cookies: [], storage: {} } })).toBe(
        false,
      )
      expect(readFileSync(f.path)).toEqual(before)
      expect(f.writes).toHaveLength(writes)
      f.fail(null)
      expect(await loadBotSession(f.kernel, "saved")).toEqual(session)
    } finally {
      f.close()
    }
  })

test("missing, invalid or replaced keys never replace the key or the encrypted session", async () => {
  for (const replacement of [null, "invalid", Buffer.alloc(32, 7).toString("base64")]) {
    const f = fixture()
    try {
      await saveBotSession({ kernel: f.kernel, botId: "saved", session })
      const before = readFileSync(f.path)
      const writes = f.writes.length
      if (replacement === null) f.keys.clear()
      else f.keys.set("browser-session-key:saved", replacement)
      await expect(loadBotSession(f.kernel, "saved")).rejects.toThrow()
      expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session })).toBe(false)
      expect(readFileSync(f.path)).toEqual(before)
      expect(f.writes).toHaveLength(writes)
    } finally {
      f.close()
    }
  }
})

test("an unavailable vault never persists a new session without encryption", async () => {
  const f = fixture()
  try {
    f.fail("VAULT_ACCESS_REQUIRED")
    expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session })).toBe(false)
    expect(existsSync(f.path)).toBe(false)
    expect(f.writes).toEqual([])
  } finally {
    f.close()
  }
})

test("legacy unencrypted sessions stay untouched when locked and are encrypted after recovery", async () => {
  const f = fixture()
  try {
    await saveBotSession({ kernel: f.kernel, botId: "saved", session })
    const legacy = JSON.stringify({ v: 1, enc: "none", data: Buffer.from(JSON.stringify(session)).toString("base64") })
    writeFileSync(f.path, legacy)
    f.fail("VAULT_ACCESS_REQUIRED")
    expect(await loadBotSession(f.kernel, "saved")).toEqual(session)
    expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session })).toBe(false)
    expect(readFileSync(f.path, "utf8")).toBe(legacy)
    f.fail(null)
    expect(await saveBotSession({ kernel: f.kernel, botId: "saved", session })).toBe(true)
    expect(JSON.parse(readFileSync(f.path, "utf8")).enc).toBe("aes-256-gcm")
    expect(await loadBotSession(f.kernel, "saved")).toEqual(session)
  } finally {
    f.close()
  }
})

test("a hung host read is bounded and leaves the encrypted session untouched", async () => {
  const f = fixture()
  try {
    await saveBotSession({ kernel: f.kernel, botId: "saved", session })
    const before = readFileSync(f.path)
    f.fail("hang")
    const started = Date.now()
    const error = await loadBotSession(f.kernel, "saved").catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SessionVaultError)
    expect((error as SessionVaultError).errorCode).toBe("VAULT_TIMEOUT")
    expect(Date.now() - started).toBeLessThan(5000)
    expect(readFileSync(f.path)).toEqual(before)
  } finally {
    f.close()
  }
})
