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
    inviter,
    origin,
    signal,
  }: {
    invite: Invite
    token: string
    inviter: Person
    origin: string
    signal: AbortSignal
  }): Promise<{ emailConfigured: boolean; emailSent: boolean; link: string }> => {
    const link = inviteLink({ origin, token })
    const config = pendingEmailConfig(authStore)
    if (!config || !(await email.hasCredentials(config))) return { emailConfigured: false, emailSent: false, link }
    const content = buildInvitationContent({ invite, inviter, config, link })
    const emailSent = await email.send({ config, content, signal })
    return { emailConfigured: true, emailSent, link }
  }

  const routes: RouteModule = {
    name: "work-people",
    routes: [
      {
        method: "GET",
        path: "/people",
        handler: async ({ signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          return { status: 200, json: { people: authStore.listPeople() } }
        },
      },
      {
        method: "GET",
        path: "/invites",
        handler: async ({ signal }) => {
          if (!isAdmin(getActor({ authStore, signal }))) return fail(403, "FORBIDDEN", "Admin role required")
          const now = Date.now()
          return {
            status: 200,
            json: {
              invites: authStore.listInvites().map((invite) => ({ ...invite, status: inviteStatus(invite, now) })),
            },
          }
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
            !isValidEmail(emailAddress) ||
            (role !== "member" && role !== "admin") ||
            channelIds === null
          )
            return fail(400, "INVALID_ARGS", "Informe nome, e-mail válido, perfil e canais existentes")
          if (authStore.listPeople().some((person) => person.email && normalizeEmail(person.email) === emailAddress))
            return fail(409, "PERSON_EXISTS", "Este e-mail já pertence a uma pessoa ativa")
          const origin = deviceSession(signal)?.origin
          if (!origin) return fail(400, "INVITE_ORIGIN_REQUIRED", "Abra o convite no navegador do servidor")
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
            inviter: actor,
            origin,
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
          const origin = deviceSession(signal)?.origin
          if (!origin) return fail(400, "INVITE_ORIGIN_REQUIRED", "Abra o convite no navegador do servidor")
          actionLimiter.record(actor.id)
          const resent = await authStore.resendInvite({ id: params.id ?? "", actorPersonId: actor.id })
          if (!resent.success) return fail(404, resent.errorCode, resent.error)
          const delivery = await issueInvite({
            invite: resent.invite,
            token: resent.token,
            inviter: actor,
            origin,
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
          return revoked.success ? { status: 200, json: {} } : fail(404, revoked.errorCode, revoked.error)
        },
      },
      {
        method: "DELETE",
        path: "/people/:id",
        handler: async ({ params, signal }) => {
          const actor = getActor({ authStore, signal })
          if (!isAdmin(actor)) return fail(403, "FORBIDDEN", "Admin role required")
          const removed = await authStore.removePerson({ id: params.id ?? "", actorPersonId: actor.id })
          return removed.success ? { status: 200, json: {} } : fail(404, removed.errorCode, removed.error)
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
          const saved = await authStore.saveEmailConfig({ actorPersonId: actor.id, config: parsed.config })
          if (!saved) return fail(403, "FORBIDDEN", "Admin role required")
          await email.saveSecrets({ config: parsed.config, input: parsed.input })
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
