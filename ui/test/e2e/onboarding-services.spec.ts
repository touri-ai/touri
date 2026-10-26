import { createECDH, randomBytes } from "node:crypto"
import { expect, test } from "@playwright/test"
import { createOnboardingFixture } from "./onboarding-fixture"

test.setTimeout(120_000)
const fixtures = new Set<Awaited<ReturnType<typeof createOnboardingFixture>>>()
test.afterEach(async () => {
  for (const fixture of fixtures) await fixture.dispose()
  fixtures.clear()
})

const start = async () => {
  const fixture = await createOnboardingFixture()
  fixtures.add(fixture)
  return fixture
}

test("desktop server registers phone push and delivers an authenticated test through its vault", async () => {
  const fixture = await start()
  await fixture.api("/onboarding", "POST", { remote: false })
  expect(await fixture.api("/qa/remote-services")).toMatchObject({ pushKeyReads: 0 })
  await fixture.api("/onboarding", "POST", { name: "Pessoa Exemplo", email: "person@example.com", remote: true })
  const request = await fixture.pairDesktop()

  const configuration = await request("/push")

  expect(configuration.status).toBe(200)
  expect(await configuration.json()).toMatchObject({ publicKey: expect.any(String), subscribed: false })
  const curve = createECDH("prime256v1")
  const subscribed = await request("/push", "PUT", {
    endpoint: "https://web.push.apple.com/test/synthetic",
    keys: { p256dh: curve.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    locale: "pt-BR",
  })
  expect(subscribed.status).toBe(200)
  expect((await request("/push/test", "POST", {})).status).toBe(200)
  expect(await fixture.api("/qa/remote-services")).toMatchObject({ push: 1, pushKeyReads: 1 })
})

test("desktop server sends configured sign-in email while preserving indistinguishable responses", async () => {
  const fixture = await start()
  await fixture.api("/onboarding", "POST", { name: "Pessoa Exemplo", email: "person@example.com", remote: false })
  const request = await fixture.pairDesktop()
  const address = await request("/public-address", "PUT", { address: "https://local.example.ts.net:8445" })
  const configured = await request("/email", "PUT", {
    transport: "smtp",
    host: "mail.example.test",
    port: 587,
    tls: true,
    fromEmail: "team@example.test",
    fromName: "touri",
    teamName: "Equipe Exemplo",
    user: "synthetic-mailer",
    password: "synthetic-password",
  })
  expect(address.status).toBe(200)
  expect(configured.status).toBe(200)

  const known = await request("/auth/email", "POST", { email: "person@example.com" })
  const unknown = await request("/auth/email", "POST", { email: "unknown@example.com" })

  expect(known.status).toBe(202)
  expect(unknown.status).toBe(202)
  expect(await known.json()).toEqual(await unknown.json())
  expect(await fixture.api("/qa/remote-services")).toMatchObject({ email: 2, pushKeyReads: 0 })
})
