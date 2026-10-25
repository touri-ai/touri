import { createHash, randomUUID } from "node:crypto"
import {
  type CloudCapabilities,
  type CloudErrorCode,
  type CloudTokens,
  errorRegistry,
  type Kernel,
} from "@touri/contracts"
import { getBotEditBody } from "@touri/contracts/bot-edit-body"

export class CloudError extends Error {
  constructor(readonly code: CloudErrorCode) {
    super(errorRegistry[code].message)
  }
}
export const cloudBaseUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CloudError("TOURI-E9008")
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    ["touri.ai", "www.touri.ai", "server.touri.ai"].includes(url.hostname) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new CloudError("TOURI-E9008")
  return url
}

export const createCloudClient = (kernel: Pick<Kernel, "callHost" | "addRedactionValue" | "services">) => {
  let tokens: CloudTokens | null = null
  let tokenOrigin = ""
  let refresh: Promise<CloudTokens> | null = null
  const settings = () => kernel.services.use("store.settings")?.()
  const base = () => {
    if (settings()?.cloud !== true) throw new CloudError("TOURI-E9013")
    return cloudBaseUrl(settings()?.cloudBaseUrl ?? "")
  }
  const webEndpoint = (path: "/parear" | "/conta", userCode?: string) => {
    const origin = cloudBaseUrl(
      settings()?.cloudWebOrigin ?? process.env.TOURI_CLOUD_WEB_ORIGIN ?? "https://staging.touri.ai",
    )
    if (["touri.ai", "www.touri.ai", "server.touri.ai"].includes(origin.hostname)) throw new CloudError("TOURI-E9008")
    const url = new URL(path, origin)
    if (userCode) url.searchParams.set("code", userCode)
    return url.toString()
  }
  const account = () => `cloud-v1/${createHash("sha256").update(base().origin).digest("hex")}`
  const forget = () => {
    tokens = null
    tokenOrigin = ""
  }
  const remember = (value: CloudTokens) => {
    if (
      !value ||
      typeof value.deviceId !== "string" ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      typeof value.refreshToken !== "string" ||
      !value.refreshToken ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw new CloudError("TOURI-E9007")
    kernel.addRedactionValue(value.accessToken)
    kernel.addRedactionValue(value.refreshToken)
    tokens = value
    tokenOrigin = base().origin
  }
  const store = async (value: CloudTokens) => {
    remember(value)
    const saved = await kernel.callHost("keychain.set", { account: account(), value: JSON.stringify(value) })
    if (!saved.success) {
      forget()
      throw new CloudError("TOURI-E9012")
    }
  }
  const load = async (): Promise<CloudTokens | null> => {
    if (tokens && tokenOrigin === base().origin) return tokens
    forget()
    const saved = await kernel.callHost("keychain.get", { account: account() })
    if (!saved.success) throw new CloudError("TOURI-E9012")
    if (saved.value.value === null) return null
    try {
      remember(JSON.parse(saved.value.value))
    } catch {
      throw new CloudError("TOURI-E9012")
    }
    return tokens
  }
  const endpoint = (path: string, ws = false) => {
    const origin = base()
    let url: URL
    try {
      url = new URL(path, origin)
    } catch {
      throw new CloudError("TOURI-E9008")
    }
    if (ws) {
      if (url.protocol !== (origin.protocol === "https:" ? "wss:" : "ws:")) throw new CloudError("TOURI-E9008")
      url.protocol = origin.protocol
    }
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/v1/") ||
      url.searchParams.has("token") ||
      url.searchParams.has("access_token")
    )
      throw new CloudError("TOURI-E9008")
    if (ws) url.protocol = origin.protocol === "https:" ? "wss:" : "ws:"
    return url.toString()
  }
  const raw = async <T>(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
    signal?: AbortSignal,
    key: string = randomUUID(),
  ): Promise<T> => {
    const url = endpoint(path)
    const credentials = tokens
    const credentialAccount = credentials ? account() : null
    let response: Response
    try {
      const requestSignal = signal ?? AbortSignal.timeout(30_000)
      const requestBody =
        body === undefined
          ? undefined
          : await getBotEditBody(body, () => new Promise<void>((resolve) => setImmediate(resolve)), requestSignal)
      response = await fetch(url, {
        method,
        redirect: "error",
        signal: requestSignal,
        headers: {
          "Content-Type": "application/json",
          "Touri-Cloud-Version": "1",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(method !== "GET" ? { "Idempotency-Key": key } : {}),
        },
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      })
    } catch {
      throw new CloudError("TOURI-E9000")
    }
    if (response.headers.get("Touri-Cloud-Version") !== "1") throw new CloudError("TOURI-E9007")
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { code?: CloudErrorCode } | null
      const code =
        error?.code && error.code in errorRegistry && error.code.startsWith("TOURI-E9") ? error.code : "TOURI-E9000"
      if (
        code === "TOURI-E9001" &&
        credentials &&
        credentialAccount &&
        tokens?.accessToken === credentials.accessToken &&
        tokens?.refreshToken === credentials.refreshToken
      ) {
        forget()
        const removed = await kernel.callHost("keychain.delete", { account: credentialAccount })
        if (!removed.success) throw new CloudError("TOURI-E9012")
      }
      throw new CloudError(code)
    }
    return response.json() as Promise<T>
  }
  const access = async (): Promise<string> => {
    const saved = await load()
    if (!saved) throw new CloudError("TOURI-E9001")
    if (Date.parse(saved.expiresAt) > Date.now() + 10_000) return saved.accessToken
    refresh ??= (async () => {
      const next = await raw<CloudTokens>("POST", "/v1/tokens/refresh", { refreshToken: saved.refreshToken })
      await store(next)
      return next
    })().finally(() => {
      refresh = null
    })
    return (await refresh).accessToken
  }
  const request = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal, key?: string) =>
    raw<T>(method, path, body, await access(), signal, key)
  const capabilities = async () => {
    const result = await raw<CloudCapabilities>("GET", "/v1/capabilities")
    if (
      result.protocolVersion !== 1 ||
      result.sandbox !== true ||
      result.runtime !== "whole-bot" ||
      result.auth !== "byok-api" ||
      !Array.isArray(result.capabilities) ||
      !Array.isArray(result.imageVersions)
    )
      throw new CloudError("TOURI-E9014")
    return result
  }
  // Bun's native WebSocket accepts handshake headers; DOM typings omit this overload.
  const AuthenticatedWebSocket = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket
  }
  const socket = async (path: string): Promise<WebSocket> => {
    const bearer = await access()
    const value = new AuthenticatedWebSocket(endpoint(path, true), {
      headers: { Authorization: `Bearer ${bearer}`, "Touri-Cloud-Version": "1" },
    })
    const timer = setTimeout(
      () => value.close(1000, "Renove a conexão"),
      Math.max(1, Date.parse(tokens?.expiresAt ?? "") - Date.now()),
    )
    timer.unref()
    value.addEventListener("close", () => clearTimeout(timer), { once: true })
    return value
  }
  const uploadReport = async (zip: Uint8Array<ArrayBuffer>, id: string): Promise<{ id: string }> => {
    if (zip.byteLength > 10 * 1024 * 1024) throw new CloudError("TOURI-E9014")
    const bearer = await access()
    const form = new FormData()
    form.append("report", new Blob([zip], { type: "application/zip" }), "report.zip")
    let response: Response
    try {
      response = await fetch(endpoint("/v1/reports"), {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${bearer}`, "Touri-Cloud-Version": "1", "Idempotency-Key": id },
      })
    } catch {
      throw new CloudError("TOURI-E9000")
    }
    if (response.headers.get("Touri-Cloud-Version") !== "1") throw new CloudError("TOURI-E9007")
    if (!response.ok) {
      if (response.status === 401) {
        forget()
        throw new CloudError("TOURI-E9001")
      }
      throw new CloudError("TOURI-E9000")
    }
    return response.json() as Promise<{ id: string }>
  }
  const unpair = async () => {
    const saved = await load()
    if (saved) {
      try {
        await request("DELETE", `/v1/devices/${encodeURIComponent(saved.deviceId)}`)
      } catch (error) {
        if (!(error instanceof CloudError) || error.code !== "TOURI-E9001") throw error
      }
    }
    const removed = await kernel.callHost("keychain.delete", { account: account() })
    forget()
    if (!removed.success) throw new CloudError("TOURI-E9012")
  }
  return {
    uploadReport,
    base,
    webEndpoint,
    endpoint,
    raw,
    request,
    capabilities,
    load,
    store,
    access,
    socket,
    unpair,
    forget,
    redactSecret: kernel.addRedactionValue,
  }
}
export type CloudClient = ReturnType<typeof createCloudClient>
