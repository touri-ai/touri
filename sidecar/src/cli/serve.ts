import { dirname, join } from "node:path"
import { closeFileIoAsync } from "../kernel/async-files"
import { prepareDatabaseAsync } from "../kernel/database-startup"
import { ensurePrivateDirectory } from "../kernel/files"
import { acquireRuntimeLock } from "../kernel/lifecycle"
import { createAppPaths } from "../kernel/paths"
import type { ServeOptions } from "./args"
import { createRateLimiter } from "./auth/rateLimit"
import { openAuthStore } from "./auth/store"
import { createEmailSignInSender } from "./email-signin"
import { createHeadlessHost } from "./host/headlessHost"
import { createSecretStore } from "./host/secretStore"
import { startHeadlessStderr } from "./nativeStderr"
import { remoteAccessWarning } from "./remoteAccessWarning"
import { clearServeInfo, writeServeInfo } from "./serveInfo"
import { closeServeFiles, registerServeShutdown } from "./serveShutdown"
import { createStartupAvailability } from "./startupAvailability"
import { startStartupListener } from "./startupListener"
import { exposeOnTailscale } from "./tailscale"
import { cliVersion } from "./version"
import { createWebGate, type MemberAuthorizer } from "./web/gate"
import { resolveUiAssets } from "./web/uiAssets"
import { initWorkMode } from "./work"

const failedPairingsPerWindow = 8
const pairingWindowMs = 60 * 1000
export const authDbName = "auth.db"

const out = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

/** Boots the sidecar kernel without Tauri and serves the UI and API from one port. */
export const runServeCommand = async (options: ServeOptions): Promise<void> => {
  const stopStderr = await startHeadlessStderr()
  try {
    await startServer(options, stopStderr)
  } catch (error) {
    await stopStderr()
    throw error
  }
}

const startServer = async (options: ServeOptions, stopStderr: () => Promise<void>): Promise<void> => {
  if ((options.trustedProxy || options.tailscale) && !["127.0.0.1", "::1", "localhost"].includes(options.host))
    throw new Error("O proxy HTTPS confiável exige --host 127.0.0.1. O acesso remoto por HTTP não é permitido.")
  process.env.TOURI_APP_DATA = options.dataDir
  process.env.TOURI_HEADLESS = "1"
  const paths = createAppPaths({ appData: options.dataDir })
  const lease = await acquireRuntimeLock(paths, { parentPid: null })
  ensurePrivateDirectory({ root: paths.appData, path: paths.runDir })
  const store = await openAuthStore({ filename: join(options.dataDir, authDbName) })
  const secrets = createSecretStore({ dir: options.dataDir })
  const ui = resolveUiAssets({ uiDir: options.uiDir, fallbackDir: join(dirname(process.execPath), "ui") })
  const authorization: { authorize: MemberAuthorizer | null } = { authorize: null }
  const intercept = createWebGate({
    store,
    secrets,
    ui,
    trustedProxy: options.trustedProxy === true || options.tailscale,
    limiter: createRateLimiter({ maxFailures: failedPairingsPerWindow, windowMs: pairingWindowMs }),
    requestEmailSignIn: createEmailSignInSender({ authStore: store, secrets }),
    authorizeMember: (input) => authorization.authorize?.(input) ?? null,
  })
  const availability = createStartupAvailability(intercept)
  const listener = startStartupListener(options.host, options.port, availability.intercept)
  const startup = new AbortController()
  const preparationStarted = performance.now()
  const abortStartup = () => startup.abort()
  process.once("SIGTERM", abortStartup)
  process.once("SIGINT", abortStartup)
  const loadRuntime = async () => {
    const [kernel, main, push] = await Promise.all([import("../kernel"), import("../main"), import("../notify/push")])
    return { createKernel: kernel.createKernel, initModules: main.initModules, initWebPush: push.initWebPush }
  }
  const preparation = prepareDatabaseAsync(options.dataDir, startup.signal)
  const prepared = Promise.all([preparation, loadRuntime()])
  const { createKernel, initModules, initWebPush } = await prepared
    .then(
      ([, runtime]) => runtime,
      async (error: unknown) => {
        startup.abort()
        await preparation.catch(() => undefined)
        listener.stop()
        await store.close()
        await lease.release()
        throw error
      },
    )
    .finally(() => {
      process.off("SIGTERM", abortStartup)
      process.off("SIGINT", abortStartup)
    })
  const runtime = createKernel({
    appData: options.dataDir,
    web: {
      hostname: options.host,
      port: options.port,
      intercept: availability.intercept,
      host: createHeadlessHost({ secrets }),
      listen: listener.listen,
    },
  })
  runtime.kernel.log({
    level: "info",
    module: "startup",
    msg: "Conversation store prepared",
    data: { durationMs: Math.round(performance.now() - preparationStarted) },
  })
  initWorkMode({ kernel: runtime.kernel, authStore: store, secrets, authorization })
  const push = await initWebPush({ kernel: runtime.kernel, authStore: store, secrets, schedule: false })
  await initModules(runtime)
  push.start()
  availability.markReady()
  const port = runtime.handshake.port
  const exposed = options.tailscale ? await exposeOnTailscale({ localPort: port }) : null
  const url = exposed?.success ? exposed.url : null
  await writeServeInfo({
    dataDir: options.dataDir,
    info: {
      pid: process.pid,
      host: options.host,
      port,
      startedAt: Date.now(),
      version: cliVersion,
      url,
      noPair: options.noPair,
    },
  })
  out(`touri ${cliVersion} listening on http://${options.host}:${port} (ui: ${ui.source})`)
  const warning = remoteAccessWarning({
    host: options.host,
    proxied: options.trustedProxy === true || options.tailscale,
  })
  if (warning) out(warning)
  if (exposed?.success) out(`tailscale: ${exposed.url}`)
  if (exposed && !exposed.success) out(`tailscale: not exposed - ${exposed.error}`)
  out(
    options.noPair
      ? "pairing: --no-pair is retired; every device, loopback included, pairs with `touri pair`"
      : "pairing: run `touri pair` for a one-time code",
  )

  registerServeShutdown({
    drainTimeoutMs: options.drainTimeoutMs,
    beginDrain: () => runtime.kernel.services.use("runtime.beginDrain")?.(),
    shutdown: async () => {
      await runtime.kernel.services.use("runtime.shutdown")?.({ appRestart: true })
    },
    log: runtime.kernel.log,
    finish: async () => {
      try {
        await push.stop()
        runtime.emitHostNotification({ method: "app.willQuit", params: {} })
        await runtime.kernel.services.use("vm.shutdown")?.()
        await clearServeInfo(options.dataDir)
        await runtime.stop()
        await store.close()
        await stopStderr()
      } finally {
        await closeServeFiles({ closeFiles: closeFileIoAsync, releaseLease: () => lease.release() })
      }
    },
  })
}
