import { isIP } from "node:net"
import type { WebInterceptArgs } from "../../kernel"
import { bindDeviceSession, type DevicePerson, deviceSession } from "../../kernel/device-session"
import { normalizeErrorBody } from "../../kernel/errors"
import type { RateLimiter } from "../auth/rateLimit"
import type { AuthStore, Device } from "../auth/store"
import type { SecretStore } from "../host/secretStore"
import { BodyError, readJsonBody } from "./body"
import { compressBufferedResponse } from "./compression"
import { isDirectLoopback } from "./loopback"
import { pairingPageHtml } from "./pairingPage"
import type { UiAssets } from "./uiAssets"

export const deviceCookieName = "touri_device"
const cookieMaxAgeSeconds = 30 * 24 * 60 * 60

export type GateOptions = {
  store: AuthStore
  limiter: RateLimiter
  ui: UiAssets
  secrets: SecretStore
  trustedProxy?: boolean
  pairReadDeadlineMs?: number
  maxPairingRequests?: number
  authorizeMember?: (input: {
    personId: string
    method: string
    pathname: string
    body: unknown
  }) => { status: number; json: unknown } | null
}
export type MemberAuthorizer = NonNullable<GateOptions["authorizeMember"]>

type Principal = { kind: "device"; device: Device; person: DevicePerson; viaCookie: boolean; token: string }

const baseHeaders: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  Response.json(normalizeErrorBody(body, status), { status, headers: { ...baseHeaders, ...extra } })

const parseCookies = (header: string | null): Record<string, string> =>
  Object.fromEntries(
    (header ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const),
  )

const trustedProxy = (args: WebInterceptArgs, options: GateOptions): boolean =>
  options.trustedProxy === true && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(args.clientIp ?? "")

const isSecureRequest = (args: WebInterceptArgs, options: GateOptions): boolean =>
  args.url.protocol === "https:" ||
  (trustedProxy(args, options) && args.request.headers.get("x-forwarded-proto") === "https")

const sourceOf = (args: WebInterceptArgs, options: GateOptions): string => {
  const forwarded = trustedProxy(args, options) ? args.request.headers.get("x-forwarded-for") : null
  return forwarded && isIP(forwarded) ? forwarded : (args.clientIp ?? "unknown")
}

const buildCookie = ({ token, secure }: { token: string; secure: boolean }): string =>
  `${deviceCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieMaxAgeSeconds}${secure ? "; Secure" : ""}`

/** Every caller needs a paired device token. Loopback is never trusted on its own:
 * other macOS accounts on the same Mac reach 127.0.0.1 too. */
const authenticate = ({ args, store }: { args: WebInterceptArgs; store: AuthStore }): Principal | null => {
  const ticketSession = deviceSession(args.request.signal)
  if (ticketSession?.active()) {
    const device = store.listDevices().find((item) => item.id === ticketSession.deviceId && item.revokedAt === null)
    const person = device ? store.getPersonForDevice(device.id) : null
    if (device && person) return { kind: "device", device, person, viaCookie: true, token: "" }
  }
  const header = args.request.headers.get("authorization")
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null
  const cookie = parseCookies(args.request.headers.get("cookie"))[deviceCookieName] ?? null
  const token = bearer ?? cookie
  const device = token === null ? null : store.verifyDeviceToken(token)
  if (device && token) {
    const person = store.getPersonForDevice(device.id)
    if (!person) return null
    const origin = args.request.headers.get("origin")
    bindDeviceSession(args.request.signal, {
      deviceId: device.id,
      person: {
        id: person.id,
        name: person.name,
        email: person.email,
        avatarSeed: person.avatarSeed,
        role: person.role,
      },
      ...(origin ? { origin } : {}),
      active: () => store.verifyDeviceToken(token)?.id === device.id,
    })
    return { kind: "device", device, person, viaCookie: bearer === null, token }
  }
  return null
}

/** Same-origin check for state-changing and WebSocket requests carrying ambient cookie credentials. */
export const originAllowed = (request: Request, proxy = false): boolean => {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  const host = (proxy ? request.headers.get("x-forwarded-host") : null) ?? request.headers.get("host")
  // A loopback request without forwarding headers (local CLI, SSH tunnel) did not come through the proxy.
  const forwardedProto = proxy ? request.headers.get("x-forwarded-proto") : null
  try {
    return (
      new URL(origin).host === host &&
      new URL(origin).protocol === (forwardedProto ? `${forwardedProto}:` : new URL(request.url).protocol)
    )
  } catch {
    return false
  }
}

const needsOriginCheck = (request: Request): boolean =>
  !["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("upgrade")?.toLowerCase() === "websocket"

const pairingPage = (): Response =>
  new Response(pairingPageHtml, {
    status: 200,
    headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
  })

const handlePair = async ({ args, options }: { args: WebInterceptArgs; options: GateOptions }): Promise<Response> => {
  const { request } = args
  if (request.method === "GET") return pairingPage()
  if (request.method !== "POST") return json(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Use POST" })
  if (!originAllowed(request, trustedProxy(args, options)))
    return json(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" })
  const source = sourceOf(args, options)
  const limit = options.limiter.check(source)
  if (!limit.allowed)
    return json(
      429,
      { errorCode: "RATE_LIMITED", error: "Too many attempts; wait and try again" },
      { "Retry-After": String(limit.retryAfterSeconds) },
    )
  const body = await readJsonBody(request, { deadlineMs: options.pairReadDeadlineMs ?? 5000 })
  if (!body) return json(400, { errorCode: "INVALID_ARGS", error: "Envie um código de pareamento válido" })
  const code = typeof body?.code === "string" ? body.code : ""
  const name = typeof body?.name === "string" ? body.name : "Browser"
  const claimed = await options.store.claimPairingCode({ code, deviceName: name })
  if (!claimed.success) {
    options.limiter.recordFailure(source)
    return json(401, { errorCode: claimed.errorCode, error: claimed.error })
  }
  options.limiter.reset(source)
  const payload =
    body?.client === true
      ? { ok: true, deviceId: claimed.device.id, token: claimed.token }
      : { ok: true, deviceId: claimed.device.id }
  return json(200, payload, {
    "Set-Cookie": buildCookie({ token: claimed.token, secure: isSecureRequest(args, options) }),
  })
}

const handleInviteRedeem = async ({
  args,
  options,
}: {
  args: WebInterceptArgs
  options: GateOptions
}): Promise<Response> => {
  const { request } = args
  if (request.method !== "POST") return json(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Use POST" })
  if (!request.headers.get("origin") || !originAllowed(request, trustedProxy(args, options)))
    return json(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" })
  const source = `invite:${sourceOf(args, options)}`
  const limit = options.limiter.check(source)
  if (!limit.allowed)
    return json(
      429,
      { errorCode: "RATE_LIMITED", error: "Too many attempts; wait and try again" },
      { "Retry-After": String(limit.retryAfterSeconds) },
    )
  const body = await readJsonBody(request, { maxBytes: 4096, deadlineMs: options.pairReadDeadlineMs ?? 5000 })
  const token = typeof body?.token === "string" ? body.token : ""
  const email = typeof body?.email === "string" ? body.email : ""
  const deviceName = typeof body?.deviceName === "string" ? body.deviceName : "Browser"
  const claimed = await options.store.claimInvite({ token, email, deviceName })
  if (!claimed.success) {
    options.limiter.recordFailure(source)
    return json(401, { errorCode: "INVALID_INVITE", error: "Convite inválido, expirado, usado ou e-mail diferente" })
  }
  options.limiter.reset(source)
  return json(
    200,
    { ok: true, deviceId: claimed.device.id },
    {
      "Set-Cookie": buildCookie({ token: claimed.token, secure: isSecureRequest(args, options) }),
    },
  )
}

const isJoinAssetRequest = ({ request, url }: { request: Request; url: URL }): boolean => {
  const referrer = request.headers.get("referer")
  if (!referrer) return false
  try {
    const parsed = new URL(referrer)
    return parsed.host === url.host && parsed.pathname === "/join"
  } catch {
    return false
  }
}

const handleSecret = async (request: Request, secrets: SecretStore): Promise<Response> => {
  const body = await readJsonBody(request)
  const account = typeof body?.account === "string" ? body.account : ""
  const value = typeof body?.value === "string" ? body.value : ""
  if (account.length === 0 || account.length > 256 || value.length === 0)
    return json(400, { errorCode: "INVALID_ARGS", error: "account and value are required" })
  await secrets.set({ account, value })
  return json(200, {})
}

const handleDevices = async ({
  args,
  principal,
  store,
}: {
  args: WebInterceptArgs
  principal: Principal
  store: AuthStore
}): Promise<Response> => {
  const { request, url } = args
  const rest = url.pathname.slice("/api/v1/devices".length).replace(/^\//, "")
  if (request.method === "GET" && rest === "")
    return json(200, {
      current: principal.kind === "device" ? principal.device.id : null,
      devices: store
        .listDevices()
        .filter((device) => device.revokedAt === null)
        .filter((device) => principal.person.role === "admin" || device.personId === principal.person.id),
    })
  if (request.method === "DELETE" && rest !== "") {
    if (principal.person.role !== "admin") return json(403, { errorCode: "FORBIDDEN", error: "Admin role required" })
    const revoked = await store.revokeDevice(rest)
    return revoked.success ? json(200, { ok: true }) : json(404, { errorCode: revoked.errorCode, error: revoked.error })
  }
  return json(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Unsupported devices request" })
}

const serveStatic = async ({
  pathname,
  request,
  ui,
}: {
  pathname: string
  request: Request
  ui: UiAssets
}): Promise<Response> => {
  if (!["GET", "HEAD"].includes(request.method)) return json(405, { errorCode: "METHOD_NOT_ALLOWED", error: "Use GET" })
  const requested = pathname === "/" ? "index.html" : pathname.slice(1)
  const exact = ui.get(requested)
  const hasExtension = /\.[A-Za-z0-9]+$/.test(requested)
  const asset = exact ?? (hasExtension ? null : ui.get("index.html"))
  if (!asset)
    return ui.source === "none"
      ? json(503, {
          errorCode: "UI_MISSING",
          error: "No UI bundle is available; start with --ui-dir or use a build that embeds it",
        })
      : json(404, { errorCode: "NOT_FOUND", error: "Not found" })
  const cache = asset.immutable ? "public, max-age=31536000, immutable" : "no-store"
  return compressBufferedResponse(
    request,
    new Response(asset.file, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Cache-Control": cache,
        "Content-Type": asset.type,
        "Content-Length": String(asset.file.size),
      },
    }),
    asset.compressed,
  )
}

const apiGate = async ({
  args,
  principal,
  options,
}: {
  args: WebInterceptArgs
  principal: Principal | null
  options: GateOptions
}): Promise<Response | null> => {
  if (principal === null) return json(401, { errorCode: "UNAUTHORIZED", error: "Pair this device first" })
  const viaCookie = principal.viaCookie
  if (!viaCookie) {
    const origin = args.request.headers.get("origin")
    if (origin === null && !args.request.headers.get("x-touri-client")?.trim())
      return json(403, { errorCode: "FORBIDDEN", error: "Native clients must send X-Touri-Client" })
    if (origin !== null && !originAllowed(args.request, trustedProxy(args, options)))
      return json(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" })
  }
  if (viaCookie && needsOriginCheck(args.request) && !originAllowed(args.request, trustedProxy(args, options)))
    return json(403, { errorCode: "FORBIDDEN", error: "Invalid Origin" })
  if (args.url.pathname.startsWith("/api/v1/devices")) return handleDevices({ args, principal, store: options.store })
  if (args.url.pathname === "/api/v1/host/secret" && principal.person.role !== "admin")
    return json(403, { errorCode: "FORBIDDEN", error: "Admin role required" })
  if (args.url.pathname === "/api/v1/host/secret" && args.request.method === "POST")
    return handleSecret(args.request, options.secrets)
  if (args.url.pathname === "/api/v1/session/rotate" && args.request.method === "POST" && principal.kind === "device") {
    const rotated = await options.store.rotateDeviceToken(principal.token)
    if (!rotated) return json(401, { errorCode: "UNAUTHORIZED" })
    return json(
      200,
      { ok: true, ...(principal.viaCookie ? {} : { token: rotated.token }) },
      {
        "Set-Cookie": buildCookie({ token: rotated.token, secure: isSecureRequest(args, options) }),
      },
    )
  }
  if (args.url.pathname === "/api/v1/session")
    return json(200, { ok: true, kind: principal.kind, person: principal.person })
  if (principal.person.role === "member" && options.authorizeMember) {
    const prefix = args.url.pathname.startsWith("/api/v1/") ? "/api/v1" : "/api"
    const decision = options.authorizeMember({
      personId: principal.person.id,
      method: args.request.method,
      pathname: args.url.pathname.slice(prefix.length) || "/",
      body: null,
    })
    if (decision) return json(decision.status, decision.json)
  }
  return null
}

/** Builds the request interceptor: pairing, device auth, static UI. Returns null to let the kernel route /api. */
export const createWebGate = (options: GateOptions): ((args: WebInterceptArgs) => Promise<Response | null>) => {
  let inFlight = 0
  const bySource = new Map<string, number>()
  const intercept = async (args: WebInterceptArgs): Promise<Response | null> => {
    const { url, request } = args
    if (!isSecureRequest(args, options) && !isDirectLoopback({ clientIp: args.clientIp, headers: request.headers }))
      return json(426, {
        errorCode: "HTTPS_REQUIRED",
        error:
          "O acesso remoto exige HTTPS. Use um proxy HTTPS confiável, como Tailscale Serve, com o servidor em loopback.",
      })
    if (url.searchParams.has("token") || url.searchParams.has("invite"))
      return json(401, { errorCode: "UNAUTHORIZED", error: "Credenciais não são aceitas na URL" })
    if (url.pathname === "/pair") {
      if (request.method !== "POST") return handlePair({ args, options })
      const source = sourceOf(args, options)
      const count = bySource.get(source) ?? 0
      if (inFlight >= (options.maxPairingRequests ?? 16) || count >= 2)
        return json(429, { errorCode: "RATE_LIMITED", error: "Aguarde para tentar parear novamente" })
      inFlight++
      bySource.set(source, count + 1)
      try {
        return await handlePair({ args, options })
      } catch (error) {
        if (error instanceof BodyError) return json(error.status, { errorCode: "INVALID_BODY", error: error.message })
        throw error
      } finally {
        inFlight--
        const left = (bySource.get(source) ?? 1) - 1
        if (left) bySource.set(source, left)
        else bySource.delete(source)
      }
    }
    if (url.pathname === "/api/v1/invites/redeem") {
      try {
        return await handleInviteRedeem({ args, options })
      } catch (error) {
        if (error instanceof BodyError) return json(error.status, { errorCode: "INVALID_BODY", error: error.message })
        throw error
      }
    }
    const principal = authenticate({ args, store: options.store })
    if (url.pathname.startsWith("/api/")) return apiGate({ args, principal, options })
    if (principal === null) {
      if (request.method === "GET" && url.pathname === "/join")
        return serveStatic({ pathname: "/join", request, ui: options.ui })
      if (["GET", "HEAD"].includes(request.method) && isJoinAssetRequest({ request, url }))
        return serveStatic({ pathname: url.pathname, request, ui: options.ui })
      const wantsPage = request.method === "GET" && !/\.[A-Za-z0-9]+$/.test(url.pathname)
      return wantsPage
        ? pairingPage()
        : json(401, { errorCode: "UNAUTHORIZED", error: "Pareie este dispositivo primeiro" })
    }
    return serveStatic({ pathname: url.pathname, request, ui: options.ui })
  }
  return async (args) => {
    const response = await intercept(args)
    return response ? compressBufferedResponse(args.request, response) : null
  }
}
