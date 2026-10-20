import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, RouteModule } from "@touri/contracts"
import { openAuthStore } from "../../src/cli/auth/store"
import type { SecretStore } from "../../src/cli/host/secretStore"
import { initWorkMode } from "../../src/cli/work"
import { bindDeviceSession } from "../../src/kernel/device-session"
import { createServices } from "../../src/kernel/services"

const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Promise.all(Array.from(cleanups, (cleanup) => cleanup()))
  cleanups.clear()
})

test("an admin can create an invite with a copy-link fallback when email is not configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "touri-work-route-"))
  const authStore = await openAuthStore({ filename: join(directory, "auth.db") })
  const database = new Database(":memory:")
  database.exec("CREATE TABLE bot_groups (id TEXT PRIMARY KEY)")
  const secretValues = new Map<string, string>()
  const deliveredTo: Array<string> = []
  const secrets: SecretStore = {
    keyOrigin: "file",
    get: (account) => secretValues.get(account) ?? null,
    getAsync: async (account) => secretValues.get(account) ?? null,
    set: async ({ account, value }) => void secretValues.set(account, value),
    delete: async (account) => void secretValues.delete(account),
  }
  const modules: Array<RouteModule> = []
  const kernel = {
    db: database,
    services: createServices(),
    registerRoutes: (module: RouteModule) => modules.push(module),
  } as unknown as Kernel
  const authorization = { authorize: null }
  cleanups.add(async () => {
    database.close()
    await authStore.close()
    await rm(directory, { recursive: true, force: true })
  })
  initWorkMode({
    kernel,
    authStore,
    secrets,
    authorization,
    emailDependencies: {
      sendSmtp: async ({ content }) => void deliveredTo.push(content.to),
    },
  })
  const workRoutes = modules.find((module) => module.name === "work-people")
  if (!workRoutes) throw new Error("Work routes were not registered")
  const signal = new AbortController().signal
  const owner = authStore.getPerson("owner")
  if (!owner) throw new Error("Owner setup failed")
  bindDeviceSession(signal, {
    deviceId: "owner-device",
    person: owner,
    origin: "https://server.example.test",
    active: () => true,
  })
  const route = workRoutes.routes.find((item) => item.method === "POST" && item.path === "/invites")
  if (!route) throw new Error("Invite route was not registered")
  const result = await route.handler({
    params: {},
    query: {},
    signal,
    body: { name: "Ana", email: "ana@example.test", role: "member", channelIds: [] },
  })
  expect(result.status).toBe(201)
  if (!("json" in result)) throw new Error("Invite response was not JSON")
  expect(result.json).toMatchObject({ emailConfigured: false, emailSent: false })
  expect((result.json as { link: string }).link).toMatch(/^https:\/\/server\.example\.test\/join#invite=/u)
  const peopleRoute = workRoutes.routes.find((item) => item.method === "GET" && item.path === "/people")
  if (!peopleRoute) throw new Error("People route was not registered")
  const anonymous = await peopleRoute.handler({
    params: {},
    query: {},
    signal: new AbortController().signal,
    body: null,
  })
  expect(anonymous.status).toBe(403)

  const emailConfiguration = {
    transport: "smtp" as const,
    host: "mail.example.test",
    port: 587,
    tls: true as const,
    fromEmail: "team@example.test",
    fromName: "Touri",
    teamName: "Minha equipe",
  }
  const emailRoute = workRoutes.routes.find((item) => item.method === "PUT" && item.path === "/email")
  if (!emailRoute) throw new Error("Email configuration route was not registered")
  const configured = await emailRoute.handler({
    params: {},
    query: {},
    signal,
    body: { ...emailConfiguration, user: "mailer", password: "private-secret" },
  })
  expect(configured.status).toBe(200)
  const stored = new Database(join(directory, "auth.db"))
  const configJson = (
    stored.query("SELECT config_json FROM email_config WHERE id = 1").get() as { config_json: string }
  ).config_json
  stored.close()
  expect(configJson).not.toContain("private-secret")
  expect(secretValues.get("work.email.smtp.password")).toBe("private-secret")
  const emailed = await route.handler({
    params: {},
    query: {},
    signal,
    body: { name: "Bia", email: "bia@example.test", role: "member", channelIds: [], to: "attacker@example.test" },
  })
  expect(emailed.status).toBe(201)
  expect(deliveredTo).toEqual(["bia@example.test"])
})
