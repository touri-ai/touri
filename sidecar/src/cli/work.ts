import type { Database } from "bun:sqlite"
import type { Kernel, RouteModule, RouteResponse } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
import { ownerPersonId } from "./auth/database"
import { createActionLimiter } from "./auth/rateLimit"
import { type AuthStore, type Invite, isValidEmail, normalizeEmail, type Person, type PersonRole } from "./auth/store"
import {
  buildInvitationContent,
  createEmailService,
  type EmailConfiguration,
  type EmailConfigurationInput,
  type EmailDependencies,
  getTestEmail,
  parseEmailConfiguration,
} from "./email"
import type { SecretStore } from "./host/secretStore"
import { getAddressReachability, parsePublicAddress } from "./public-address"
import type { MemberAuthorizer } from "./web/gate"
import { createWorkAccess } from "./work-access"

const fail = (status: number, errorCode: string, error: string): RouteResponse => ({
  status,
  json: { errorCode, error },
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const asText = (value: unknown): string => (typeof value === "string" ? value : "")

const getActor = ({ authStore, signal }: { authStore: AuthStore; signal: AbortSignal }): Person | null => {
  const session = deviceSession(signal)?.person
  return session ? authStore.getPerson(session.id) : null
}

const isAdmin = (actor: Person | null): actor is Person => actor?.role === "admin"

const inviteLink = ({ origin, token }: { origin: string; token: string }): string => {
  const link = new URL("/join", origin)
  link.hash = `invite=${encodeURIComponent(token)}`
  return link.toString()
}

const inviteSecretName = (id: string): string => `work.invite.${id}`

const pendingEmailConfig = (authStore: AuthStore) => parseEmailConfiguration(authStore.getEmailConfig())

const inviteStatus = (invite: Invite, now: number): "pending" | "accepted" | "revoked" | "expired" => {
  if (invite.usedAt !== null) return "accepted"
  if (invite.revokedAt !== null) return "revoked"
  if (invite.expiresAt <= now) return "expired"
  return "pending"
}

const selectedChannels = ({ database, value }: { database: Database; value: unknown }): Array<string> | null => {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    value.some((id) => typeof id !== "string" || !id || id.length > 128)
  )
    return null
  const ids = value as Array<string>
  if (new Set(ids).size !== ids.length) return null
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(",")
  const found = database.query(`SELECT id FROM bot_groups WHERE id IN (${placeholders})`).all(...ids) as Array<{
    id: string
  }>
  return found.length === ids.length ? ids : null
}

const getEmailInput = (value: unknown): { config: EmailConfiguration; input: EmailConfigurationInput } | null => {
  if (!isRecord(value)) return null
  const config = parseEmailConfiguration(value)
  if (!config) return null
  const user = asText(value.user)
  const password = asText(value.password)
  const apiKey = asText(value.apiKey)
  const clearCredentials = value.clearCredentials === true
  if (
    user.length > 256 ||
    password.length > 4096 ||
    apiKey.length > 4096 ||
    /[\r\n\0]/u.test(user) ||
    /[\r\n\0]/u.test(password) ||
    /[\r\n\0]/u.test(apiKey)
  )
    return null
  return {
    config,
    input: {
      ...config,
      ...(user ? { user } : {}),
      ...(password ? { password } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(clearCredentials ? { clearCredentials: true } : {}),
    },
  }
}

export const initWorkMode = ({
  kernel,
  authStore,
  secrets,
  authorization,
  emailDependencies,
}: {
  kernel: Kernel
  authStore: AuthStore
  secrets: SecretStore
  authorization: { authorize: MemberAuthorizer | null }
  emailDependencies?: EmailDependencies
}): void => {
  const database = kernel.db as Database
  const access = createWorkAccess({ database, authStore })
  const email = createEmailService({ secrets, ...(emailDependencies ? { dependencies: emailDependencies } : {}) })
  const actionLimiter = createActionLimiter({ maxActions: 5, windowMs: 60_000 })

  authorization.authorize = ({ personId, method, pathname, body }) =>
    access.authorizeHttp({ personId, role: "member", method, pathname, body })
  kernel.services.provide("work.authorizeHttp", access.authorizeHttp)
  kernel.services.provide("work.authorizeSocket", access.authorizeSocket)
  kernel.services.provide("work.visibleEvent", access.visibleEvent)
  kernel.services.provide("work.canAccessThread", access.canAccessThread)
  kernel.services.provide("work.canAccessGroup", access.canAccessGroup)
  kernel.services.provide("work.canAccessBot", access.canAccessBot)
  kernel.services.provide("work.canAccessBrowserTab", access.canAccessBrowserTab)
  kernel.services.provide("work.ownsBot", access.ownsBot)
  kernel.services.provide("work.accessibleBotIds", access.accessibleBotIds)
  kernel.services.provide("work.canAccessAttachments", access.canAccessAttachments)
  kernel.services.provide("work.canAccessRun", access.canAccessRun)
  kernel.services.provide("work.accessibleRunIds", access.accessibleRunIds)
  kernel.services.provide("work.canAccessNotification", access.canAccessNotification)
  kernel.services.provide("work.canApprove", access.canApprove)
  kernel.services.provide("work.personForRun", access.personForRun)
  kernel.services.provide("work.isAdminRun", access.isAdminRun)
  kernel.services.provide("work.personChannelIds", access.channelIdsFor)
  kernel.services.provide("work.defaultPersonId", () => ownerPersonId)

  const issueInvite = async ({
    invite,
    token,
    code,
    inviter,
    requestOrigin,
    publicAddress,
    signal,
  }: {
    invite: Invite
    token: string
    code: string
    inviter: Person
    requestOrigin: string | null
    publicAddress: string
    signal: AbortSignal
  }): Promise<{
    emailConfigured: boolean
    emailSent: boolean
    link: string
    code: string
    requestOriginReachability: ReturnType<typeof getAddressReachability>
    publicAddressReachability: ReturnType<typeof getAddressReachability>
  }> => {
    const link = inviteLink({ origin: publicAddress, token })
    await secrets.set({ account: inviteSecretName(invite.id), value: token })
    const config = pendingEmailConfig(authStore)
    const requestOriginReachability = getAddressReachability(requestOrigin)
    const publicAddressReachability = getAddressReachability(publicAddress)
    if (!invite.email || !config || !(await email.hasCredentials(config)))
      return {
        emailConfigured: false,
        emailSent: false,
        link,
        code,
        requestOriginReachability,
        publicAddressReachability,
      }
    const content = buildInvitationContent({ invite, inviter, config, link })
    const emailSent = await email.send({ config, content, signal })
    return { emailConfigured: true, emailSent, link, code, requestOriginReachability, publicAddressReachability }
  }

  const routes: RouteModule = {
    name: "work-people",
    routes: [
      {
        method: "GET",
        path: "/people",
        handler: async ({ signal }) => {
          const actor = getActor({ authStore, signal })
          if (!actor) return fail(403, "FORBIDDEN", "Pair this device first")
          const people = authStore.listPeople().filter((person) => actor.role === "admin" || person.id === actor.id)
          const devices = authStore.listActiveDevices(actor.role === "admin" ? undefined : actor.id)
          return {
            status: 200,
            json: {
              people: people.map((person) => ({
                ...person,
                devices: devices.filter((device) => device.personId === person.id),
              })),
            },
          }
        },
      },
      {
        method: "POST",
        path: "/pairing-codes",
        handler: async ({ signal }) => {
          const actor = getActor({ authStore, signal })
          if (!actor) return fail(403, "FORBIDDEN", "Pair this device first")
          const limited = actionLimiter.check(actor.id)
          if (!limited.allowed)
            return { status: 429, json: { errorCode: "RATE_LIMITED", retryAfterSeconds: limited.retryAfterSeconds } }
          actionLimiter.record(actor.id)
          const pairing = await authStore.createPersonPairingCode(actor.id)
          if (!pairing.success) return fail(404, pairing.errorCode, pairing.error)
          return { status: 201, json: { code: pairing.code, expiresAt: pairing.expiresAt } }
        },
      },
      {
        method: "GET",
        path: "/public-address",
        handler: async ({ signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          const address = parsePublicAddress(authStore.getPublicAddress()) || null
          const requestOrigin = deviceSession(signal)?.origin ?? null
          return {
            status: 200,
            json: {
              address,
              reachability: getAddressReachability(address),
              requestOriginReachability: getAddressReachability(requestOrigin),
            },
          }
        },
      },
      {
        method: "PUT",
        path: "/public-address",
        handler: async ({ body, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const input = isRecord(body) ? body.address : undefined
          const address = input === null || input === "" ? null : parsePublicAddress(input)
          if (address === null && input !== null && input !== "")
            return fail(400, "INVALID_ARGS", "Informe um endereço HTTPS válido, sem caminho")
          const saved = await authStore.savePublicAddress({ actorPersonId: actor.id, address })
          if (!saved) return fail(403, "FORBIDDEN", "Admin role required")
          const publicAddress = address || null
          return { status: 200, json: { address: publicAddress, reachability: getAddressReachability(publicAddress) } }
        },
      },
      {
        method: "GET",
        path: "/invites",
        handler: async ({ signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          const now = Date.now()
          const invites = authStore.listInvites()
          await Promise.all(
            invites
              .filter((invite) => inviteStatus(invite, now) !== "pending")
              .map((invite) => secrets.delete(inviteSecretName(invite.id))),
          )
          return {
            status: 200,
            json: {
              invites: invites.map((invite) => ({ ...invite, status: inviteStatus(invite, now) })),
            },
          }
        },
      },
      {
        method: "GET",
        path: "/invites/:id/link",
        handler: async ({ params, signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          const invite = authStore.listInvites().find((item) => item.id === params.id)
          if (!invite || inviteStatus(invite, Date.now()) !== "pending")
            return fail(404, "NOT_FOUND", "Invite not found")
          const address = parsePublicAddress(authStore.getPublicAddress())
          if (!address) return fail(409, "PUBLIC_ADDRESS_REQUIRED", "Configure o endereço público primeiro")
          const token = await secrets.getAsync(inviteSecretName(invite.id))
          if (!token) return fail(404, "NOT_FOUND", "Invite link is no longer available")
          return { status: 200, json: { link: inviteLink({ origin: address, token }) } }
        },
      },
      {
        method: "POST",
        path: "/invites",
        handler: async ({ body, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const limited = actionLimiter.check(actor.id)
          if (!limited.allowed)
            return { status: 429, json: { errorCode: "RATE_LIMITED", retryAfterSeconds: limited.retryAfterSeconds } }
          const input = isRecord(body) ? body : {}
          const name = asText(input.name).trim()
          const emailAddress = normalizeEmail(asText(input.email))
          const role = input.role
          const channelIds = selectedChannels({ database, value: input.channelIds })
          if (
            name.length === 0 ||
            name.length > 80 ||
            (emailAddress !== "" && !isValidEmail(emailAddress)) ||
            (role !== "member" && role !== "admin") ||
            channelIds === null
          )
            return fail(400, "INVALID_ARGS", "Informe nome, e-mail válido, perfil e canais existentes")
          if (authStore.listPeople().some((person) => person.email && normalizeEmail(person.email) === emailAddress))
            return fail(409, "PERSON_EXISTS", "Este e-mail já pertence a uma pessoa ativa")
          const publicAddress = parsePublicAddress(authStore.getPublicAddress())
          if (!publicAddress) return fail(409, "PUBLIC_ADDRESS_REQUIRED", "Configure o endereço público primeiro")
          const requestOrigin = deviceSession(signal)?.origin ?? null
          actionLimiter.record(actor.id)
          const created = await authStore.createInvite({
            actorPersonId: actor.id,
            name,
            email: emailAddress,
            role: role as PersonRole,
            channelIds,
          })
          if (!created.success) return fail(409, created.errorCode, created.error)
          const delivery = await issueInvite({
            invite: created.invite,
            token: created.token,
            code: created.code,
            inviter: actor,
            requestOrigin,
            publicAddress,
            signal,
          })
          return { status: 201, json: { invite: created.invite, ...delivery } }
        },
      },
      {
        method: "POST",
        path: "/invites/:id/resend",
        handler: async ({ params, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const limited = actionLimiter.check(actor.id)
          if (!limited.allowed)
            return { status: 429, json: { errorCode: "RATE_LIMITED", retryAfterSeconds: limited.retryAfterSeconds } }
          const publicAddress = parsePublicAddress(authStore.getPublicAddress())
          if (!publicAddress) return fail(409, "PUBLIC_ADDRESS_REQUIRED", "Configure o endereço público primeiro")
          const requestOrigin = deviceSession(signal)?.origin ?? null
          actionLimiter.record(actor.id)
          const resent = await authStore.resendInvite({ id: params.id ?? "", actorPersonId: actor.id })
          if (!resent.success) return fail(404, resent.errorCode, resent.error)
          const delivery = await issueInvite({
            invite: resent.invite,
            token: resent.token,
            code: resent.code,
            inviter: actor,
            requestOrigin,
            publicAddress,
            signal,
          })
          return { status: 200, json: { invite: resent.invite, ...delivery } }
        },
      },
      {
        method: "DELETE",
        path: "/invites/:id",
        handler: async ({ params, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const revoked = await authStore.revokeInvite({ id: params.id ?? "", actorPersonId: actor.id })
          if (!revoked.success) return fail(404, revoked.errorCode, revoked.error)
          await secrets.delete(inviteSecretName(params.id ?? ""))
          return { status: 200, json: {} }
        },
      },
      {
        method: "DELETE",
        path: "/people/:id",
        handler: async ({ params, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const person = authStore.getPerson(params.id ?? "")
          const inviteSecretNames = authStore
            .listInvites()
            .filter((invite) => invite.createdByPersonId === person?.id || invite.email === person?.email)
            .map((invite) => inviteSecretName(invite.id))
          const removed = await authStore.removePerson({ id: params.id ?? "", actorPersonId: actor.id })
          if (!removed.success) return fail(404, removed.errorCode, removed.error)
          await Promise.all(inviteSecretNames.map((account) => secrets.delete(account)))
          return { status: 200, json: {} }
        },
      },
      {
        method: "GET",
        path: "/email",
        handler: async ({ signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          const config = pendingEmailConfig(authStore)
          return {
            status: 200,
            json: { configuration: config, configured: config ? await email.hasCredentials(config) : false },
          }
        },
      },
      {
        method: "PUT",
        path: "/email",
        handler: async ({ body, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const parsed = getEmailInput(body)
          if (!parsed) return fail(400, "INVALID_ARGS", "Confira o servidor, TLS e o endereço de envio")
          if (!(await email.hasCredentialsWithInput({ config: parsed.config, input: parsed.input })))
            return fail(400, "EMAIL_CREDENTIALS_REQUIRED", "Informe as credenciais de envio")
          await email.saveSecrets({ config: parsed.config, input: parsed.input })
          const saved = await authStore.saveEmailConfig({ actorPersonId: actor.id, config: parsed.config })
          if (!saved) return fail(403, "FORBIDDEN", "Admin role required")
          return { status: 200, json: { configuration: parsed.config, configured: true } }
        },
      },
      {
        method: "DELETE",
        path: "/email",
        handler: async ({ signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          await Promise.all([
            secrets.delete("work.email.smtp.user"),
            secrets.delete("work.email.smtp.password"),
            secrets.delete("work.email.api-key"),
          ])
          const saved = await authStore.saveEmailConfig({ actorPersonId: actor.id, config: null })
          return saved ? { status: 200, json: {} } : fail(403, "FORBIDDEN", "Admin role required")
        },
      },
      {
        method: "POST",
        path: "/email/test",
        handler: async ({ body, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const recipient = normalizeEmail(asText(isRecord(body) ? body.to : null))
          if (!isValidEmail(recipient)) return fail(400, "INVALID_ARGS", "Informe um e-mail válido para o teste")
          const config = pendingEmailConfig(authStore)
          if (!config || !(await email.hasCredentials(config)))
            return fail(409, "EMAIL_NOT_CONFIGURED", "Configure o envio de e-mail primeiro")
          const testContent = getTestEmail({ teamName: config.teamName })
          const sent = await email.send({ config, content: { ...testContent, to: recipient }, signal })
          return sent
            ? { status: 200, json: { sent: true } }
            : fail(502, "EMAIL_SEND_FAILED", "Não foi possível enviar o e-mail de teste")
        },
      },
    ],
  }
  kernel.registerRoutes(routes)
}
