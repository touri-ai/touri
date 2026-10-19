import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UiEvent } from "@touri/contracts"
import { computerUseDisabledReason, createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "touri-host-"))
  const events: Array<UiEvent> = []
  const secrets = createSecretStore({ dir, env: {} })
  const callHost = createHeadlessHost({ secrets })({ publish: (event) => events.push(event), log: () => undefined })
  return { dir, events, callHost, secrets }
}

test("secrets round-trip through an encrypted 0600 file", async () => {
  const { dir, callHost } = setup()
  expect(await callHost("keychain.set", { account: "p1/DB_URL", value: "postgres://user:hunter2@host/db" })).toEqual({
    success: true,
    value: {},
  })
  expect(await callHost("keychain.get", { account: "p1/DB_URL" })).toEqual({
    success: true,
    value: { value: "postgres://user:hunter2@host/db" },
  })
  expect(await callHost("keychain.get", { account: "missing" })).toEqual({ success: true, value: { value: null } })
  const raw = readFileSync(join(dir, "secrets.enc"), "utf8")
  expect(raw).not.toContain("hunter2")
  expect(statSync(join(dir, "secrets.enc")).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, "secrets.key")).mode & 0o777).toBe(0o600)
  await callHost("keychain.delete", { account: "p1/DB_URL" })
  expect(await callHost("keychain.get", { account: "p1/DB_URL" })).toEqual({ success: true, value: { value: null } })
})

test("a second store on the same directory reads what the first wrote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "touri-host-"))
  await createSecretStore({ dir, env: {} }).set({ account: "a", value: "1" })
  expect(createSecretStore({ dir, env: {} }).get("a")).toBe("1")
})

test("concurrent secret writes preserve both accounts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "touri-host-"))
  const store = createSecretStore({ dir, env: {} })
  await Promise.all([store.set({ account: "first", value: "one" }), store.set({ account: "second", value: "two" })])
  const reopened = createSecretStore({ dir, env: {} })
  expect(reopened.get("first")).toBe("one")
  expect(reopened.get("second")).toBe("two")
})

test("TOURI_SECRETS_KEY replaces the key file and a wrong key cannot decrypt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "touri-host-"))
  const store = createSecretStore({ dir, env: { TOURI_SECRETS_KEY: "one" } })
  await store.set({ account: "a", value: "1" })
  expect(store.keyOrigin).toBe("env")
  expect(() => createSecretStore({ dir, env: { TOURI_SECRETS_KEY: "two" } }).get("a")).toThrow()
})

test("computer use and permissions report a clear reason instead of pretending", async () => {
  const { callHost } = setup()
  const click = await callHost("computer.click", { x: 1, y: 1, button: "left", clickCount: 1, modifiers: [] })
  expect(click).toEqual({ success: false, errorCode: "HOST_ERROR", error: computerUseDisabledReason })
  const permissions = await callHost("permissions.status", {})
  expect(permissions).toMatchObject({ success: false, errorCode: "HOST_ERROR" })
  expect(computerUseDisabledReason).toContain("headless")
})

test("notifications become UI events", async () => {
  const { callHost, events } = setup()
  await callHost("notify", { title: "Done", body: "Run finished", threadId: null })
  expect(events).toEqual([{ type: "notify", level: "info", title: "Done", body: "Run finished", threadId: null }])
})

test("approval echoes preserve the request identity regardless of the displayed title", async () => {
  const { dir, callHost, events } = setup()
  try {
    await callHost("notify", {
      title: "Café Ideias: Revisar",
      body: "Autorizar ação",
      threadId: "thread-a",
      requestId: "request-a",
      notificationId: 7,
      kind: "approval",
    })
    expect(events).toEqual([
      {
        type: "notify",
        level: "info",
        title: "Café Ideias: Revisar",
        body: "Autorizar ação",
        threadId: "thread-a",
        requestId: "request-a",
        notificationId: 7,
        kind: "approval",
      },
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
