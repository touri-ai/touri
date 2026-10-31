import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { DiscoveredServer, Kernel, OnboardingStatus } from "@touri/contracts"
import { createRateLimiter } from "../cli/auth/rateLimit"
import { type AuthStore, isValidEmail, openAuthStore } from "../cli/auth/store"
import type { EmailDependencies } from "../cli/email"
import { createEmailSignInSender } from "../cli/email-signin"
import type { SecretStore } from "../cli/host/secretStore"
import { exposeOnTailscale, type RunCommand, runCommand, stopTailscaleAccess } from "../cli/tailscale"
import { createWebGate, type MemberAuthorizer } from "../cli/web/gate"
import { resolveUiAssets } from "../cli/web/uiAssets"
import { initWorkMode } from "../cli/work"
import type { WebMode } from "../kernel"
import { readPrivateFileAsync, writePrivateFileAsync } from "../kernel/async-files"
import { deviceSession } from "../kernel/device-session"
import { initWebPush } from "../notify/push"
import type { sendWebPush } from "../notify/push-transport"
import { getServerCandidates, probeServer } from "./discovery"

type Preferences = { completed: boolean; remoteUrl: string | null; remotePort?: number | undefined }

/** The desktop and remote devices share one runtime, store and existing authenticated web transport. */
export const createDesktopWeb = async (
  appData: string,
  options: {
    port?: number
    run?: RunCommand
    probe?: typeof probeServer
    localServerUrl?: string | null
    emailDependencies?: EmailDependencies
    pushSend?: typeof sendWebPush
  } = {},
) => {
  const authStore = await openAuthStore({ filename: join(appData, "auth.db") })
  let host: Kernel["callHost"] | null = null
  const getHost = () => {
    if (!host) throw new Error("HOST_UNAVAILABLE")
    return host
  }
  const secrets: SecretStore = {
    get: () => {
      throw new Error("Use asynchronous vault access")
    },
    getAsync: async (account) => {
      const result = await getHost()("keychain.get", { account })
      if (!result.success) throw new Error(result.errorCode)
      return result.value.value
    },
    set: async (input) => {
      const result = await getHost()("keychain.set", input)
      if (!result.success) throw new Error(result.errorCode)
    },
    delete: async (account) => {
      const result = await getHost()("keychain.delete", { account })
      if (!result.success) throw new Error(result.errorCode)
    },
    keyOrigin: "system",
  }
  const authorization: { authorize: MemberAuthorizer | null } = { authorize: null }
  const intercept = createWebGate({
    store: authStore,
    secrets,
    ui: resolveUiAssets({ uiDir: null, fallbackDir: join(import.meta.dir, "../../../ui/dist") }),
    trustedProxy: true,
    limiter: createRateLimiter({ maxFailures: 8, windowMs: 60_000 }),
    requestEmailSignIn: createEmailSignInSender({
      authStore,
      secrets,
      ...(options.emailDependencies ? { dependencies: options.emailDependencies } : {}),
    }),
    authorizeMember: (input) => authorization.authorize?.(input) ?? null,
  })
  const web: WebMode = { hostname: "127.0.0.1", port: options.port ?? 0, nativeDesktop: true, intercept }
  // Keep one initialization per desktop; local-only startup never opens the push vault entry.
  let push: ReturnType<typeof initWebPush> | null = null
  const startRemoteServices = async (kernel: Kernel) => {
    if (!push)
      push = initWebPush({ kernel, authStore, secrets, ...(options.pushSend ? { send: options.pushSend } : {}) }).catch(
        (error: unknown) => {
          push = null
          throw error
        },
      )
    await push
  }
  const init = async (kernel: Kernel, port: number) => {
    host = kernel.callHost
    initWorkMode({
      kernel,
      authStore,
      secrets,
      authorization,
      ...(options.emailDependencies ? { emailDependencies: options.emailDependencies } : {}),
    })
    await initDesktopOnboarding({
      kernel,
      authStore,
      port,
      ...options,
      startRemoteServices: () => startRemoteServices(kernel),
    })
  }

  const stop = async () => {
    const ready = await push?.catch(() => null)
    await ready?.stop()
  }

  return { web, init, stop, close: () => authStore.close() }
}

export const initDesktopOnboarding = async ({
  kernel,
  authStore,
  port,
  run = runCommand,
  probe = probeServer,
  localServerUrl = "http://127.0.0.1:8795",
  startRemoteServices,
}: {
  kernel: Kernel
  authStore: AuthStore
  port: number
  run?: RunCommand
  probe?: typeof probeServer
  localServerUrl?: string | null
  startRemoteServices: () => Promise<void>
}) => {
  const filename = join(kernel.paths.appData, "onboarding.json")
  let preferences = await getPreferences(kernel.paths.appData)
  let candidates: Array<DiscoveredServer> = []
  let scanning: Promise<Awaited<ReturnType<typeof getServerCandidates>>> | null = null
  let starting = false
  let probing = 0
  let cachedDiscovery: { at: number; result: Awaited<ReturnType<typeof getServerCandidates>> } | null = null
  const database = kernel.db as Database
  const hasData = Boolean(
    database.query("SELECT 1 FROM bots LIMIT 1").get() ||
      // Maintenance can write its checkpoint before the first-run screen mounts.
      database
        .query("SELECT 1 FROM settings WHERE key NOT IN ('storage.maintenance.progress', 'storage.upgrade.22') LIMIT 1")
        .get(),
  )
  const savePreferences = async (next: Preferences) => {
    await writePrivateFileAsync({ root: kernel.paths.appData, path: filename, content: JSON.stringify(next) })
    preferences = next
  }
  const getCandidates = (signal: AbortSignal) => {
    if (cachedDiscovery && Date.now() - cachedDiscovery.at < 10_000) return Promise.resolve(cachedDiscovery.result)
    if (scanning) return scanning
    scanning = getServerCandidates({ localUrl: localServerUrl, signal, run })
      .then((result) => {
        const discovered = {
          ...result,
          servers: result.servers.filter((server) => `${server.url}/` !== preferences.remoteUrl),
        }
        candidates = discovered.servers
        cachedDiscovery = { at: Date.now(), result: discovered }
        return discovered
      })
      .finally(() => {
        scanning = null
      })
    return scanning
  }
  const restoreRemote = async () => {
    if (!preferences.remoteUrl) return
    await startRemoteServices()
    const exposed = await exposeOnTailscale({ localPort: port, run, previousLocalPort: preferences.remotePort })
    if (exposed.success) await savePreferences({ ...preferences, remoteUrl: exposed.url, remotePort: port })
    // Do not publish subprocess diagnostics or private network identifiers in logs.
    if (!exposed.success) kernel.log({ level: "warn", module: "onboarding", msg: "Remote access needs attention" })
  }
  const restoration = restoreRemote().catch(() => undefined)
  kernel.registerRoutes({
    name: "desktop-onboarding",
    routes: [
      {
        method: "GET",
        path: "/session",
        handler: async ({ signal }) => {
          const session = deviceSession(signal)
          if (!session?.native || !session.active() || !session.person) return forbidden()
          return { status: 200, json: { ok: true, kind: "device", person: session.person } }
        },
      },
      {
        method: "GET",
        path: "/onboarding",
        handler: async ({ signal }) => {
          if (isRemoteSession(signal)) return forbidden()
          const status: OnboardingStatus = {
            completed: preferences.completed || hasData,
            ...(localServerUrl ? { localUrl: localServerUrl } : {}),
            runtimeUrl: `http://127.0.0.1:${port}`,
            hasData,
            tailscale: "unavailable",
            remoteUrl: preferences.remoteUrl,
          }
          return { status: 200, json: status }
        },
      },
      {
        method: "GET",
        path: "/onboarding/servers",
        handler: async ({ signal }) => {
          if (isRemoteSession(signal)) return forbidden()
          return { status: 200, json: await getCandidates(signal) }
        },
      },
      {
        method: "POST",
        path: "/onboarding/probe",
        handler: async ({ signal, body }) => {
          if (isRemoteSession(signal)) return forbidden()
          const url = body && typeof body === "object" && "url" in body ? body.url : null
          if (typeof url !== "string" || (url !== localServerUrl && !candidates.some((server) => server.url === url)))
            return forbidden()
          if (probing >= 4) return { status: 429, json: { errorCode: "RATE_LIMITED" } }
          probing += 1
          try {
            return { status: 200, json: { found: await probe(url, signal) } }
          } finally {
            probing -= 1
          }
        },
      },
      {
        method: "POST",
        path: "/onboarding/pair-code",
        handler: async ({ signal }) => {
          if (isRemoteSession(signal)) return forbidden()
          return { status: 200, json: await authStore.createPairingCode() }
        },
      },
      {
        method: "POST",
        path: "/onboarding",
        handler: async ({ signal, body }) => {
          if (isRemoteSession(signal)) return forbidden()
          if (starting) return { status: 409, json: { errorCode: "ONBOARDING_BUSY" } }
          const input = getStartInput(body)
          if (!input) return { status: 400, json: { errorCode: "INVALID_ARGS" } }
          starting = true
          try {
            await restoration
            signal.throwIfAborted()
            if (input.name && !(await authStore.saveOwnerProfile(input))) throw new Error("PROFILE_SAVE_FAILED")
            if (input.remote) await startRemoteServices()
            const exposed = input.remote
              ? await exposeOnTailscale({
                  localPort: port,
                  run: (cmd, args) => run(cmd, args, signal),
                  previousLocalPort: preferences.remotePort,
                })
              : null
            if (exposed && !exposed.success) return { status: 503, json: { errorCode: "ONBOARDING_REMOTE_FAILED" } }
            if (
              !input.remote &&
              preferences.remoteUrl &&
              !(await stopTailscaleAccess(preferences.remotePort ?? port, run))
            )
              return { status: 503, json: { errorCode: "ONBOARDING_REMOTE_FAILED" } }
            const url = exposed?.success ? exposed.url : null
            await savePreferences({ completed: true, remoteUrl: url, remotePort: port })
            return { status: 200, json: { completed: true, url } }
          } finally {
            starting = false
          }
        },
      },
    ],
  })
}

const isRemoteSession = (signal: AbortSignal): boolean => {
  const session = deviceSession(signal)
  return Boolean(session && !session.native)
}

const forbidden = () => ({ status: 403, json: { errorCode: "FORBIDDEN" } })

const getStartInput = (body: unknown): { name: string; email: string; remote: boolean } | null => {
  if (!body || typeof body !== "object" || !("remote" in body) || typeof body.remote !== "boolean") return null
  const name = "name" in body && typeof body.name === "string" ? body.name.trim() : ""
  const email = "email" in body && typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (
    name.length > 80 ||
    /[\r\n\0]/.test(name) ||
    (email && !isValidEmail(email)) ||
    (body.remote && (!name || !email))
  )
    return null
  return { name, email, remote: body.remote }
}

const getPreferences = async (appData: string): Promise<Preferences> => {
  try {
    const bytes = await readPrivateFileAsync({ root: appData, path: join(appData, "onboarding.json"), maxBytes: 4096 })
    if (!bytes) return { completed: false, remoteUrl: null }
    const value = JSON.parse(bytes.toString("utf8")) as Partial<Preferences>
    return {
      completed: value.completed === true,
      remoteUrl: typeof value.remoteUrl === "string" ? value.remoteUrl : null,
      remotePort: Number.isInteger(value.remotePort) ? value.remotePort : undefined,
    }
  } catch {
    return { completed: false, remoteUrl: null }
  }
}
