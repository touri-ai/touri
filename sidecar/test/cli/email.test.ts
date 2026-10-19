import { expect, test } from "bun:test"
import {
  buildInvitationContent,
  createEmailService,
  getInviteEmail,
  isPublicAddress,
  parseEmailConfiguration,
} from "../../src/cli/email"
import type { SecretStore } from "../../src/cli/host/secretStore"

const makeSecrets = (): SecretStore => {
  const values = new Map<string, string>()
  return {
    keyOrigin: "file",
    get: (account) => values.get(account) ?? null,
    getAsync: async (account) => values.get(account) ?? null,
    set: async ({ account, value }) => void values.set(account, value),
    delete: async (account) => void values.delete(account),
  }
}

const smtp = {
  transport: "smtp" as const,
  host: "mail.example.test",
  port: 587,
  tls: true as const,
  fromEmail: "team@example.test",
  fromName: "Time",
  teamName: "Equipe Touri",
}

test("HTTP email transport accepts only public IPv4 destinations", () => {
  expect(isPublicAddress("8.8.8.8")).toBe(true)
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
  ]) {
    expect(isPublicAddress(address)).toBe(false)
  }
})

test("invitation email has escaped plain and HTML pt-BR and English text without tracking", () => {
  const content = getInviteEmail({
    invite: { name: "Ana <admin>", expiresAt: 1_800_000_000_000 },
    inviter: { name: "Admin & equipe" },
    config: { teamName: "Equipe <A>", fromName: "Touri" },
    link: "https://server.example.test/join#invite=secret-token",
  })
  expect(content.subject).toContain("Admin & equipe")
  expect(content.text).toContain("convidou você")
  expect(content.text).toContain("invited you")
  expect(content.text).toContain("expira em 24 horas")
  expect(content.text).toContain("expires in 24 hours")
  expect(content.html).toContain("Ana &lt;admin&gt;")
  expect(content.html).toContain("Equipe &lt;A&gt;")
  expect(content.html).not.toContain("Ana <admin>")
  expect(content.html).not.toContain("pixel")
  expect(content.html).toContain("https://server.example.test/join#invite=secret-token")
})

test("SMTP and HTTP delivery use only stored secrets and the invited recipient", async () => {
  const secrets = makeSecrets()
  const sent: Array<{ transport: string; to: string; secret: string }> = []
  const email = createEmailService({
    secrets,
    dependencies: {
      sendSmtp: async ({ credentials, content }) => {
        sent.push({ transport: "smtp", to: content.to, secret: credentials.password ?? "" })
      },
      sendHttp: async ({ credentials, content }) => {
        sent.push({ transport: "http", to: content.to, secret: credentials.apiKey ?? "" })
      },
    },
  })
  await email.saveSecrets({ config: smtp, input: { ...smtp, user: "mailer", password: "smtp-secret" } })
  expect(await email.hasCredentials(smtp)).toBe(true)
  expect(
    await email.send({
      config: smtp,
      content: { to: "ana@example.test", subject: "Invite", text: "text", html: "<p>text</p>" },
    }),
  ).toBe(true)

  const http = parseEmailConfiguration({
    transport: "http",
    endpoint: "https://mail-api.example.test/v1/send",
    fromEmail: "team@example.test",
    fromName: "Time",
    teamName: "Equipe Touri",
  })
  if (!http) throw new Error("HTTP configuration was rejected")
  await email.saveSecrets({ config: http, input: { ...http, apiKey: "http-secret" } })
  const content = buildInvitationContent({
    invite: {
      id: "invite-id",
      name: "Ana",
      email: "ana@example.test",
      role: "member",
      channelIds: [],
      createdByPersonId: "owner",
      createdAt: 1,
      expiresAt: 86_401,
      usedAt: null,
      revokedAt: null,
    },
    inviter: {
      id: "owner",
      name: "Owner",
      email: null,
      avatarSeed: "owner",
      role: "admin",
      createdAt: 1,
      removedAt: null,
    },
    config: http,
    link: "https://server.example.test/join#invite=token",
  })
  expect(await email.send({ config: http, content })).toBe(true)
  expect(sent).toEqual([
    { transport: "smtp", to: "ana@example.test", secret: "smtp-secret" },
    { transport: "http", to: "ana@example.test", secret: "http-secret" },
  ])
})

test("email settings require TLS and reject unsafe HTTP endpoints and header injection", () => {
  expect(parseEmailConfiguration({ ...smtp, tls: false })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, host: "127.0.0.1" })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, host: "mail.localhost" })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, fromEmail: "team@example.test,other@example.test" })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, fromEmail: "group:team@example.test;" })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, fromName: "Touri\r\nBcc: victim@example.test" })).toBeNull()
  expect(parseEmailConfiguration({ ...smtp, teamName: "Team\nInjected" })).toBeNull()
  expect(
    parseEmailConfiguration({
      transport: "http",
      endpoint: "http://mail.example.test/send",
      fromEmail: "team@example.test",
      fromName: "Time",
      teamName: "Equipe",
    }),
  ).toBeNull()
  expect(
    parseEmailConfiguration({
      transport: "http",
      endpoint: "https://127.0.0.1/send",
      fromEmail: "team@example.test",
      fromName: "Time",
      teamName: "Equipe",
    }),
  ).toBeNull()
  expect(
    parseEmailConfiguration({
      transport: "http",
      endpoint: "https://mail.example.test/send?redirect=http://127.0.0.1",
      fromEmail: "team@example.test",
      fromName: "Time",
      teamName: "Equipe",
    }),
  ).toBeNull()
})

test("missing credentials safely reports that delivery is unavailable", async () => {
  const email = createEmailService({ secrets: makeSecrets() })
  expect(await email.hasCredentials(smtp)).toBe(false)
  expect(
    await email.send({
      config: smtp,
      content: { to: "ana@example.test", subject: "Invite", text: "text", html: "<p>text</p>" },
    }),
  ).toBe(false)
})
