import { Resolver } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { connect, isIP, type Socket } from "node:net"
import nodemailer from "nodemailer"
import { withDeadline } from "../kernel/policy"
import type { Invite, Person } from "./auth/store"
import { isValidEmail } from "./auth/store"
import type { SecretStore } from "./host/secretStore"

const emailTimeoutMs = 10_000
const dnsTimeoutMs = 5_000
const responseLimitBytes = 16_384
const smtpUserAccount = "work.email.smtp.user"
const smtpPasswordAccount = "work.email.smtp.password"
const apiKeyAccount = "work.email.api-key"

export type EmailConfiguration =
  | {
      transport: "smtp"
      host: string
      port: number
      tls: true
      fromEmail: string
      fromName: string
      teamName: string
    }
  | {
      transport: "http"
      endpoint: string
      fromEmail: string
      fromName: string
      teamName: string
    }

export type EmailConfigurationInput = EmailConfiguration & {
  user?: string
  password?: string
  apiKey?: string
  clearCredentials?: boolean
}

export type EmailContent = { to: string; subject: string; text: string; html: string }
export type EmailCredentials = { user?: string; password?: string; apiKey?: string }

export type EmailDependencies = {
  sendSmtp?: (input: {
    config: EmailConfiguration
    credentials: EmailCredentials
    content: EmailContent
    signal: AbortSignal
  }) => Promise<void>
  sendHttp?: (input: {
    config: EmailConfiguration
    credentials: EmailCredentials
    content: EmailContent
    signal: AbortSignal
  }) => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isText = (value: unknown): value is string => typeof value === "string"
const cleanHeader = (value: string): boolean => value.length > 0 && value.length <= 120 && !/[\r\n\0]/u.test(value)
const safeHeaderText = (value: string): string =>
  Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join("")
    .slice(0, 120)
    .trim()

export const parseEmailConfiguration = (value: unknown): EmailConfiguration | null => {
  if (!isRecord(value)) return null
  const fromEmail = isText(value.fromEmail) ? value.fromEmail.trim() : ""
  const fromName = isText(value.fromName) ? value.fromName.trim() : ""
  const teamName = isText(value.teamName) ? value.teamName.trim() : ""
  if (!isValidEmail(fromEmail) || !cleanHeader(fromName) || !cleanHeader(teamName)) return null
  if (value.transport === "smtp") {
    const host = isText(value.host) ? value.host.trim() : ""
    const port = value.port
    if (
      !/^[a-zA-Z0-9.-]{1,253}$/u.test(host) ||
      host.startsWith(".") ||
      host.endsWith(".") ||
      isIP(host) !== 0 ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      !Number.isInteger(port) ||
      (port as number) < 1 ||
      (port as number) > 65535 ||
      value.tls !== true
    )
      return null
    return { transport: "smtp", host, port: port as number, tls: true, fromEmail, fromName, teamName }
  }
  if (value.transport !== "http" || !isText(value.endpoint) || value.endpoint.length > 2048) return null
  let endpoint: URL
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    return null
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.hostname ||
    isIP(endpoint.hostname)
  )
    return null
  return { transport: "http", endpoint: endpoint.toString(), fromEmail, fromName, teamName }
}

export const getInviteEmail = ({
  invite,
  inviter,
  config,
  link,
}: {
  invite: Pick<Invite, "name" | "expiresAt">
  inviter: Pick<Person, "name">
  config: Pick<EmailConfiguration, "teamName" | "fromName">
  link: string
}): EmailContent => {
  const escapeHtml = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
  const name = invite.name.trim()
  const teamName = config.teamName.trim()
  const invitedBy = inviter.name.trim()
  const safeLink = escapeHtml(link)
  const safeName = escapeHtml(name)
  const safeTeam = escapeHtml(teamName)
  const safeInviter = escapeHtml(invitedBy)
  const expires = new Date(invite.expiresAt).toISOString()
  const subject = `${safeHeaderText(invitedBy)} convidou você para ${safeHeaderText(teamName)}`
  const text = [
    `Olá, ${name}!`,
    `${invitedBy} convidou você para participar de ${teamName} no touri.`,
    `Aceitar convite: ${link}`,
    `O link expira em 24 horas (${expires}).`,
    "",
    `Hello, ${name}!`,
    `${invitedBy} invited you to join ${teamName} on touri.`,
    `Accept invitation: ${link}`,
    `This link expires in 24 hours (${expires}).`,
  ].join("\n")
  const html = [
    `<p>Olá, ${safeName}!</p>`,
    `<p>${safeInviter} convidou você para participar de ${safeTeam} no touri.</p>`,
    `<p><a href="${safeLink}">Aceitar convite</a></p>`,
    `<p>O link expira em 24 horas (${escapeHtml(expires)}).</p>`,
    "<hr>",
    `<p>Hello, ${safeName}!</p>`,
    `<p>${safeInviter} invited you to join ${safeTeam} on touri.</p>`,
    `<p><a href="${safeLink}">Accept invitation</a></p>`,
    `<p>This link expires in 24 hours (${escapeHtml(expires)}).</p>`,
  ].join("\n")
  return { to: "", subject, text, html }
}

export const getTestEmail = ({ teamName }: { teamName: string }): Omit<EmailContent, "to"> => ({
  subject: `Configuração de e-mail de ${teamName}`,
  text: `O envio de e-mail de ${teamName} está funcionando.\n\nEmail delivery for ${teamName} is working.`,
  html: `<p>O envio de e-mail de ${escapeHtmlText(teamName)} está funcionando.</p><hr><p>Email delivery for ${escapeHtmlText(teamName)} is working.</p>`,
})

const escapeHtmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

export const isPublicAddress = (address: string): boolean => {
  if (isIP(address) !== 4) return false
  const parts = address.split(".").map(Number)
  const first = parts[0] ?? 0
  const second = parts[1] ?? 0
  const third = parts[2] ?? 0
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168 || (second === 88 && third === 99))) return false
  if (first === 198 && (second === 18 || second === 19 || second === 51)) return false
  if (first === 203 && second === 0 && third === 113) return false
  return true
}

const getPublicAddress = (hostname: string, signal: AbortSignal): Promise<{ address: string; family: 4 }> =>
  withDeadline({
    signal,
    timeoutMs: dnsTimeoutMs,
    operation: async (lookupSignal) => {
      const resolver = new Resolver()
      const cancel = () => resolver.cancel()
      lookupSignal.addEventListener("abort", cancel, { once: true })
      try {
        const addresses = await resolver.resolve4(hostname)
        if (!addresses.length || addresses.some((address) => !isPublicAddress(address)))
          throw new Error("Email endpoint must resolve only to public addresses")
        const [first] = addresses
        if (!first) throw new Error("Email endpoint did not resolve")
        return { address: first, family: 4 }
      } finally {
        lookupSignal.removeEventListener("abort", cancel)
      }
    },
  })

const requestHttpEmail = async ({
  endpoint,
  apiKey,
  config,
  content,
  signal,
}: {
  endpoint: string
  apiKey: string
  config: EmailConfiguration
  content: EmailContent
  signal: AbortSignal
}): Promise<void> => {
  const url = new URL(endpoint)
  const { address, family } = await getPublicAddress(url.hostname, signal)
  const payload = JSON.stringify({
    from: { email: config.fromEmail, name: config.fromName },
    to: [{ email: content.to }],
    subject: content.subject,
    text: content.text,
    html: content.html,
  })
  const response = await new Promise<{ statusCode: number; bytes: number }>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          Host: url.host,
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address, family }])
            return
          }
          callback(null, address, family)
        },
        servername: url.hostname,
        maxHeaderSize: 8_192,
      },
      (response) => {
        response.on("error", reject)
        let bytes = 0
        response.on("data", (chunk: Uint8Array) => {
          bytes += chunk.byteLength
          if (bytes > responseLimitBytes) request.destroy(new Error("Email response exceeded its size limit"))
        })
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, bytes }))
      },
    )
    request.on("error", reject)
    request.end(payload)
  })
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error("Email API rejected delivery")
}

const requestSmtpEmail = async ({
  config,
  credentials,
  content,
  signal,
}: {
  config: EmailConfiguration
  credentials: EmailCredentials
  content: EmailContent
  signal: AbortSignal
}): Promise<void> => {
  if (config.transport !== "smtp" || !credentials.user || !credentials.password)
    throw new Error("SMTP settings are incomplete")
  const address = await getPublicAddress(config.host, signal)
  signal.throwIfAborted()
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = connect({ host: address.address, port: config.port, signal })
    connection.once("connect", () => resolve(connection))
    connection.once("error", reject)
  })
  const transporter = nodemailer.createTransport({
    connection: socket,
    host: address.address,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: credentials.user, pass: credentials.password },
    connectionTimeout: emailTimeoutMs,
    greetingTimeout: emailTimeoutMs,
    socketTimeout: emailTimeoutMs,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true, servername: config.host },
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    await transporter.sendMail({
      from: { address: config.fromEmail, name: config.fromName },
      to: content.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    })
  } finally {
    socket.destroy()
    transporter.close()
  }
}

export const createEmailService = ({
  secrets,
  dependencies = {},
  timeoutMs = emailTimeoutMs,
}: {
  secrets: SecretStore
  dependencies?: EmailDependencies
  timeoutMs?: number
}) => {
  const getCredentials = async (config: EmailConfiguration): Promise<EmailCredentials> => {
    if (config.transport === "smtp") {
      const [user, password] = await Promise.all([
        secrets.getAsync(smtpUserAccount),
        secrets.getAsync(smtpPasswordAccount),
      ])
      return { ...(user ? { user } : {}), ...(password ? { password } : {}) }
    }
    const apiKey = await secrets.getAsync(apiKeyAccount)
    return apiKey ? { apiKey } : {}
  }

  const send = async ({
    config,
    content,
    signal,
  }: {
    config: EmailConfiguration
    content: EmailContent
    signal?: AbortSignal
  }): Promise<boolean> => {
    if (!isValidEmail(content.to)) return false
    try {
      return await withDeadline({
        ...(signal ? { signal } : {}),
        timeoutMs,
        operation: (deliverySignal) => sendWithSignal({ config, content, signal: deliverySignal }),
      })
    } catch {
      return false
    }
  }

  const sendWithSignal = async ({
    config,
    content,
    signal,
  }: {
    config: EmailConfiguration
    content: EmailContent
    signal: AbortSignal
  }): Promise<boolean> => {
    const credentials = await getCredentials(config)
    signal.throwIfAborted()
    if (config.transport === "smtp") {
      if (!credentials.user || !credentials.password) return false
      await (dependencies.sendSmtp ?? requestSmtpEmail)({ config, credentials, content, signal })
      return true
    }
    if (!credentials.apiKey) return false
    if (dependencies.sendHttp) {
      await dependencies.sendHttp({ config, credentials, content, signal })
      return true
    }
    await requestHttpEmail({ endpoint: config.endpoint, apiKey: credentials.apiKey, config, content, signal })
    return true
  }

  const saveSecrets = async ({
    config,
    input,
  }: {
    config: EmailConfiguration
    input: EmailConfigurationInput
  }): Promise<void> => {
    if (input.clearCredentials) {
      await Promise.all([
        secrets.delete(smtpUserAccount),
        secrets.delete(smtpPasswordAccount),
        secrets.delete(apiKeyAccount),
      ])
    }
    if (config.transport === "smtp") {
      const writes = [
        input.user ? secrets.set({ account: smtpUserAccount, value: input.user }) : Promise.resolve(),
        input.password ? secrets.set({ account: smtpPasswordAccount, value: input.password }) : Promise.resolve(),
        secrets.delete(apiKeyAccount),
      ]
      await Promise.all(writes)
      return
    }
    await Promise.all([
      input.apiKey ? secrets.set({ account: apiKeyAccount, value: input.apiKey }) : Promise.resolve(),
      secrets.delete(smtpUserAccount),
      secrets.delete(smtpPasswordAccount),
    ])
  }

  const hasCredentials = async (config: EmailConfiguration): Promise<boolean> => {
    const credentials = await getCredentials(config)
    if (config.transport === "smtp") return Boolean(credentials.user && credentials.password)
    return Boolean(credentials.apiKey)
  }

  const hasCredentialsWithInput = async ({
    config,
    input,
  }: {
    config: EmailConfiguration
    input: EmailConfigurationInput
  }): Promise<boolean> => {
    if (config.transport === "smtp") {
      const [savedUser, savedPassword] = input.clearCredentials
        ? [null, null]
        : await Promise.all([secrets.getAsync(smtpUserAccount), secrets.getAsync(smtpPasswordAccount)])
      return Boolean((input.user || savedUser) && (input.password || savedPassword))
    }
    const savedKey = input.clearCredentials ? null : await secrets.getAsync(apiKeyAccount)
    return Boolean(input.apiKey || savedKey)
  }

  return { send, saveSecrets, hasCredentials, hasCredentialsWithInput }
}

export const buildInvitationContent = ({
  invite,
  inviter,
  config,
  link,
}: {
  invite: Invite
  inviter: Person
  config: EmailConfiguration
  link: string
}): EmailContent => ({
  ...getInviteEmail({ invite, inviter, config, link }),
  to: invite.email,
})
