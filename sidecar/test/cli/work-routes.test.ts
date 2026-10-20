import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, RouteModule } from "@touri/contracts"
import { openAuthStore } from "../../src/cli/auth/store"
import { createEmailSignInSender } from "../../src/cli/email-signin"
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
    origin: "http://192.168.1.20:8795",
    active: () => true,
  })
  const route = workRoutes.routes.find((item) => item.method === "POST" && item.path === "/invites")
  if (!route) throw new Error("Invite route was not registered")
  const withoutAddress = await route.handler({
    params: {},
    query: {},
    signal,
    body: { name: "Ana", email: "ana@example.test", role: "member", channelIds: [] },
  })
  expect(withoutAddress.status).toBe(409)

  const addressRoute = workRoutes.routes.find((item) => item.method === "PUT" && item.path === "/public-address")
  if (!addressRoute) throw new Error("Public-address route was not registered")
  const address = await addressRoute.handler({
    params: {},
    query: {},
    signal,
    body: { address: "https://public.example.test" },
  })
  expect(address.status).toBe(200)
  const addressStatusRoute = workRoutes.routes.find((item) => item.method === "GET" && item.path === "/public-address")
  if (!addressStatusRoute) throw new Error("Public-address status route was not registered")
  const addressStatus = await addressStatusRoute.handler({ params: {}, query: {}, signal, body: null })
  expect(addressStatus).toMatchObject({
    status: 200,
    json: { reachability: "public", requestOriginReachability: "private" },
  })

  const result = await route.handler({
    params: {},
    query: {},
    signal,
    body: { name: "Ana", email: "ana@example.test", role: "member", channelIds: [] },
  })
  expect(result.status).toBe(201)
  if (!("json" in result)) throw new Error("Invite response was not JSON")
  expect(result.json).toMatchObject({ emailConfigured: false, emailSent: false, requestOriginReachability: "private" })
  expect((result.json as { link: string }).link).toMatch(/^https:\/\/public\.example\.test\/join#invite=/u)
  const peopleRoute = workRoutes.routes.find((item) => item.method === "GET" && item.path === "/people")
  if (!peopleRoute) throw new Error("People route was not registered")
  const authDatabase = new Database(join(directory, "auth.db"))
  const insertDevice = authDatabase.query(
    "INSERT INTO devices(id,name,token_hash,created_at,last_seen_at,person_id) VALUES(?,?,?,?,?,?)",
  )
  authDatabase.transaction(() =>
    Array.from({ length: 501 }, (_, index) => index).forEach((index) => {
      insertDevice.run(
        `synthetic-${index.toString().padStart(4, "0")}`,
        "Synthetic device",
        `hash-${index}`,
        index,
        index,
        "owner",
      )
    }),
  )()
  const devicePlan = authDatabase
    .query(
      "EXPLAIN QUERY PLAN SELECT id,name,person_id,created_at,last_seen_at,revoked_at FROM devices INDEXED BY devices_active_id WHERE revoked_at IS NULL ORDER BY id LIMIT 500",
    )
    .all() as Array<{ detail: string }>
  const personDevicePlan = authDatabase
    .query(
      "EXPLAIN QUERY PLAN SELECT id,name,person_id,created_at,last_seen_at,revoked_at FROM devices INDEXED BY devices_active_person_id WHERE person_id = 'owner' AND revoked_at IS NULL ORDER BY id LIMIT 500",
    )
    .all() as Array<{ detail: string }>
  authDatabase.close()
  expect(devicePlan.map(({ detail }) => detail).join(" ")).toContain("devices_active_id")
  expect(personDevicePlan.map(({ detail }) => detail).join(" ")).toContain("devices_active_person_id")
  const anonymous = await peopleRoute.handler({
    params: {},
    query: {},
    signal: new AbortController().signal,
    body: null,
  })
  expect(anonymous.status).toBe(403)
  const people = await peopleRoute.handler({ params: {}, query: {}, signal, body: null })
  expect(people.status).toBe(200)
  if (!("json" in people)) throw new Error("People response was not JSON")
  const listedPeople = (people.json as { people: Array<{ devices: Array<unknown> }> }).people
  expect(listedPeople[0]?.devices).toHaveLength(500)

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
  if (!("json" in configured)) throw new Error("Email configuration response was not JSON")
  expect(JSON.stringify(configured.json)).not.toContain("private-secret")
  const stored = new Database(join(directory, "auth.db"))
  const configJson = (
    stored.query("SELECT config_json FROM email_config WHERE id = 1").get() as { config_json: string }
  ).config_json
  stored.close()
  expect(configJson).not.toContain("private-secret")
  expect(secretValues.get("work.email.smtp.password")).toBe("private-secret")
  const sentContent: Array<{ to: string; text: string }> = []
  const sendSignIn = createEmailSignInSender({
    authStore,
    secrets,
    dependencies: { sendSmtp: async ({ content }) => void sentContent.push({ to: content.to, text: content.text }) },
  })
  await sendSignIn({ emailAddress: "unlisted@example.test", signal })
  expect(sentContent).toHaveLength(1)
  expect(sentContent[0]?.to).toBe("unlisted@example.test")
  expect(sentContent[0]?.text).toContain("https://public.example.test/login#signin=")
  const emailed = await route.handler({
    params: {},
    query: {},
    signal,
    body: { name: "Bia", email: "bia@example.test", role: "member", channelIds: [], to: "attacker@example.test" },
  })
  expect(emailed.status).toBe(201)
  expect(deliveredTo).toEqual(["bia@example.test"])

  const copyRoute = workRoutes.routes.find((item) => item.method === "GET" && item.path === "/invites/:id/link")
  if (!copyRoute) throw new Error("Copy-link route was not registered")
  const copied = await copyRoute.handler({
    params: { id: (result.json as { invite: { id: string } }).invite.id },
    query: {},
    signal,
    body: null,
  })
  expect(copied).toMatchObject({ status: 200 })
  if (!("json" in copied)) throw new Error("Copy-link response was not JSON")
  expect((copied.json as { link: string }).link).toMatch(/^https:\/\/public\.example\.test\/join#invite=/u)
})
