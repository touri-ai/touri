import { afterEach, expect, test } from "bun:test"
import type { OwnerAvatar, RouteModule } from "@touri/contracts"
import { bindDeviceSession, type DeviceSession } from "../../src/kernel/device-session"
import { init } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(async () => {
  await Promise.all(Array.from(fixtures, (fixture) => fixture.close()))
  fixtures.clear()
})

test("owner profile persists name and photo, supports replacement and removal", async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await init(fixture.kernel)
  const avatar: OwnerAvatar = { kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }

  const saved = await fixture.request("PATCH /settings", { ownerProfile: { name: "Pessoa Teste", avatar } })
  const read = await fixture.request("GET /settings", {})

  expect(saved.status).toBe(200)
  expect(read.json).toMatchObject({ settings: { ownerProfile: { name: "Pessoa Teste", avatar } } })
  expect(fixture.kernel.services.use("store.settings")?.().ownerProfile?.avatar).toEqual(avatar)
  const mascot = { kind: "mascot", avatarSeed: "owner", avatarShape: "short-flower", color: "#abcdef" }
  const replaced = await fixture.request("PATCH /settings", { ownerProfile: { name: "Pessoa Teste", avatar: mascot } })
  const removed = await fixture.request("PATCH /settings", { ownerProfile: { name: "Pessoa Teste", avatar: null } })

  expect(replaced.json).toMatchObject({ settings: { ownerProfile: { avatar: mascot } } })
  expect(removed.json).toMatchObject({ settings: { ownerProfile: { avatar: null } } })
})

test.each([
  { name: "x".repeat(81), avatar: null },
  { name: "test", avatar: { kind: "image", dataUrl: "https://example.test/photo.png" } },
  { name: "test", avatar: { kind: "image", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } },
  { name: "test", avatar: { kind: "image", dataUrl: `data:image/png;base64,${"a".repeat(100_001)}` } },
  { name: "test", avatar: { kind: "mascot", avatarSeed: "owner", avatarShape: "invalid", color: null } },
])("rejects malformed or oversized profile %j", async (ownerProfile) => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await init(fixture.kernel)

  const response = await fixture.request("PATCH /settings", { ownerProfile })

  expect(response.status).toBe(400)
})

test.each(["member", "admin"] as const)("another %s cannot replace the owner's identity", async (role) => {
  const fixture = testKernel()
  fixtures.add(fixture)
  const route = await registerSettingsRoute(fixture)
  const signal = new AbortController().signal
  bindDeviceSession(signal, {
    deviceId: "test-device",
    active: () => true,
    person: { id: "another-person", name: "Outra Pessoa", email: null, avatarSeed: "other", role },
  })

  const response = await route.handler({
    body: { ownerProfile: { name: "Changed", avatar: null } },
    params: {},
    query: {},
    signal,
  })

  expect(response.status).toBe(403)
  expect(fixture.kernel.services.use("store.settings")?.().ownerProfile?.name).toBe("")
})

test.each([
  { active: () => true },
  { active: () => false, person: { id: "owner", name: "Pessoa", email: null, avatarSeed: "owner", role: "admin" } },
  {
    active: () => true,
    automation: "notices",
    person: { id: "owner", name: "Pessoa", email: null, avatarSeed: "owner", role: "admin" },
  },
] satisfies Array<Omit<DeviceSession, "deviceId">>)(
  "a session without an active human owner cannot change the profile: %j",
  async (session) => {
    const fixture = testKernel()
    fixtures.add(fixture)
    const route = await registerSettingsRoute(fixture)
    const signal = new AbortController().signal
    bindDeviceSession(signal, { deviceId: "test-device", ...session })

    const response = await route.handler({
      body: { ownerProfile: { name: "Changed", avatar: null } },
      params: {},
      query: {},
      signal,
    })

    expect(response.status).toBe(403)
    expect(fixture.kernel.services.use("store.settings")?.().ownerProfile?.name).toBe("")
  },
)

test("an active owner device can update the profile", async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  const route = await registerSettingsRoute(fixture)
  const signal = new AbortController().signal
  bindDeviceSession(signal, {
    deviceId: "owner-device",
    active: () => true,
    person: { id: "owner", name: "Pessoa", email: null, avatarSeed: "owner", role: "admin" },
  })

  const response = await route.handler({
    body: { ownerProfile: { name: "Pessoa Teste", avatar: null } },
    params: {},
    query: {},
    signal,
  })

  expect(response.status).toBe(200)
  expect(fixture.kernel.services.use("store.settings")?.().ownerProfile?.name).toBe("Pessoa Teste")
})

const registerSettingsRoute = async (
  fixture: ReturnType<typeof testKernel>,
): Promise<RouteModule["routes"][number]> => {
  const routes = new Map<string, RouteModule["routes"][number]>()
  await init({
    ...fixture.kernel,
    registerRoutes: (module) => {
      module.routes.forEach((route) => {
        routes.set(`${route.method} ${route.path}`, route)
      })
      fixture.kernel.registerRoutes(module)
    },
  })
  const route = routes.get("PATCH /settings")
  if (!route) throw new Error("Missing settings route")

  return route
}
