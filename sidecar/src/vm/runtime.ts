import type { Database } from "bun:sqlite"
import { createHash, randomBytes } from "node:crypto"
import { rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  Bot,
  Kernel,
  MachineCapability,
  MachineConnection,
  MachineState,
  Result,
  ToolResult,
  VmRuntime,
} from "@touri/contracts"
import { getApiRequiredHosts } from "../api-models/runtime"
import { createBackgroundTask, getMeasuredStage, yieldBackground } from "../kernel/background-task"
import { botFolderFingerprint } from "../kernel/bot-folders"
import { TouriError } from "../kernel/errors"
import { atomicWriteFile, ensurePrivateDirectory, removePrivateFile } from "../kernel/files"
import type { PerformanceStageRunner } from "../kernel/performance"
import { isIdle } from "../kernel/policy"
import { safeThreadId } from "../mcp/auth"
import { createRunMcpToken } from "../mcp/run-token"
import { resolveMcpEndpoint } from "../platform/transport"
import { copyProjectSnapshot } from "../projects/vm-snapshot"
import { applyProviderPrivacy, cliTelemetryOff } from "../runtime/privacy"
import { connectMcpBridge } from "./bridge"
import {
  BROWSER_FLAGS,
  BROWSER_LAUNCH_SHELL,
  BROWSER_LIVENESS_EVERY,
  BROWSER_LOG_TAIL_COMMAND,
  BROWSER_RUNNING_COMMAND,
  BROWSER_START_BUDGET_MS,
  BROWSER_STOP_COMMAND,
  BrowserStartError,
  browserStartMessage,
  CLEAR_STALE_PROFILE_LOCKS_COMMAND,
} from "./browser-launch"
import clipboard from "./clipboard.py" with { type: "text" }
import { configureBridge } from "./configure-bridge"
import { machineCapability } from "./doctor"
import {
  installEgressPolicy,
  providerHosts,
  readEgressPolicy,
  saveEgressPolicy,
  tightenEgressPolicy,
} from "./egress-policy"
import { botFolderMounts, withoutHostFolderMounts } from "./folder-mounts"
import { GUEST_WRITE_COMMAND } from "./guest-write"
import { BOT_DNS, BOT_IMAGE } from "./image"
import { ProviderLoginError, providerLoginSource, readProviderLogin, VAULT_READ_DEADLINE_MS } from "./provider-login"
import { redactVmEvents } from "./redact-events"
import { DEFAULT_BOT_VM_MEMORY_MB, validBotVmMemory } from "./resources"
import { type ConnectionKeys, connectionKeyId, memoryConnectionKeys, sealConnection } from "./sealed-connection"
import { isMachineServiceFailure, MachineServiceError, machineErrorState } from "./service-error"
import { withMachineServiceRecovery } from "./service-wait"
import { abortVmWait, vmStage } from "./stage"
import type { VmProvider, VmVolumeSpec } from "./types"
import { vncPasswordFile } from "./vnc-auth"

type Metadata = {
  bot_id: string
  vm_id: string
  volume: string
  project_id: string | null
  folder_fingerprint: string
  created_ms: number | null
  start_ms: number | null
}
const unwrap = <T>(result: Result<T>): T => {
  if (!result.success) {
    if (isMachineServiceFailure(result.errorCode)) throw new MachineServiceError(result.errorCode, result.error)
    throw new Error(result.error)
  }
  const { success: _, ...value } = result
  return value as T
}
// Older metadata stores just the workspace volume name. Upgrades record every
// persistent mount before deletion so a failed/canceled recreation can retry.
const persistentMounts = (meta: Metadata): Array<VmVolumeSpec> =>
  meta.volume.startsWith("[")
    ? (JSON.parse(meta.volume) as Array<VmVolumeSpec>)
    : [{ type: "volume", source: meta.volume, target: "/workspace" }]

const imageMatches = (image: string) => image.replace(/^docker\.io\/library\//, "") === BOT_IMAGE
const dnsMatches = (dns: Array<string>) => BOT_DNS.every((server) => dns.includes(server))
const guestEnv = {
  HOME: "/workspace/.home",
  CODEX_HOME: "/workspace/.home/.codex",
  DISPLAY: ":99",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  SHELL: "/bin/sh",
  TOURI_RUN_DIR: "/workspace/.touri/run",
  TOURI_PROJECT_DATA_DIR: "/workspace/.touri/data",
}

const browserEnv = {
  HOME: "/var/lib/touri-browser",
  DISPLAY: ":99",
  XAUTHORITY: "/var/lib/touri-browser/.Xauthority",
  PATH: guestEnv.PATH,
}

export const GUEST_READY_COMMAND =
  "if test -f /run/touri-init-error; then cat /run/touri-init-error >&2; exit 1; fi; /usr/sbin/runuser -u node -- test -w /workspace/.touri/run && test -f /tmp/touri-ready && test -S /tmp/touri-mcp.sock && xdotool getdisplaygeometry >/dev/null 2>&1"

export const createVmRuntime = ({
  kernel,
  provider,
  capability = machineCapability(),
  now = Date.now,
  hostHome = homedir(),
  timeouts = {},
  connectionKeys = memoryConnectionKeys(kernel),
  runStage,
}: {
  kernel: Kernel
  provider: VmProvider
  capability?: MachineCapability
  now?: () => number
  hostHome?: string
  timeouts?: Partial<{ boot: number; ready: number; auth: number; exec: number; service: number }>
  runStage?: PerformanceStageRunner
  connectionKeys?: ConnectionKeys
}) => {
  const limits = { boot: 600_000, ready: 90_000, auth: 15_000, exec: 30_000, ...timeouts }
  const db = kernel.db as Database
  const states = new Map<string, MachineState>()
  const locks = new Map<string, Promise<unknown>>()
  const users = new Map<string, number>()
  const touched = new Map<string, number>()
  // Shared timestamps keep a restarted/observing runtime from using stale local activity.
  const operations = new Map<string, number>()
  const touch = (botId: string) => {
    const at = now()
    touched.set(botId, at)
    db.query(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
      WHERE settings.updated_at < excluded.updated_at`).run(`vm-activity:${botId}`, String(at), at)
  }
  const persistedActivity = (botId: string) => {
    const row = db.query("SELECT updated_at FROM settings WHERE key = ?").get(`vm-activity:${botId}`) as {
      updated_at: number
    } | null
    return row?.updated_at ?? null
  }
  const lastActivity = (botId: string) => {
    const persisted = persistedActivity(botId)
    return Math.max(touched.get(botId) ?? persisted ?? now(), persisted ?? 0)
  }
  const withActivity = async <T>(botId: string, action: () => Promise<T>): Promise<T> => {
    operations.set(botId, (operations.get(botId) ?? 0) + 1)
    try {
      touch(botId)
      return await action()
    } finally {
      operations.set(botId, Math.max(0, (operations.get(botId) ?? 1) - 1))
      touch(botId)
    }
  }
  const acquiring = new Map<string, number>()
  // Heartbeats cover the open tab/terminal even before RFB connects or after it fails.
  // Socket sessions keep their own refcounted leases, independently of app focus.
  const viewers = new Map<string, Map<string, number>>()
  const connectedViewers = new Map<string, number>()
  const leased = (botId: string) => {
    const presence = viewers.get(botId)
    for (const [id, expires] of presence ?? []) if (expires <= now()) presence?.delete(id)
    return Boolean(
      users.get(botId) ||
        operations.get(botId) ||
        children.get(botId)?.size ||
        acquiring.get(botId) ||
        connectedViewers.get(botId) ||
        presence?.size ||
        db
          .query("SELECT 1 FROM runs WHERE bot_id = ? AND status IN ('queued', 'starting', 'running') LIMIT 1")
          .get(botId),
    )
  }
  const bridges = new Map<string, () => void>()
  const turnTokens = new Map<string, Set<() => void>>()
  const liveStaging = new Set<string>()
  const credentialCleanups = new Map<string, Promise<void>>()
  const connections = new Map<string, { connection: MachineConnection; token: string; desktopPassword: string }>()
  const warming = new Map<string, { promise: Promise<MachineState>; controller: AbortController }>()
  const serviceStarts = new Map<string, Promise<MachineState | null>>()
  const parkRequested = new Map<string, { intent: "idle" }>()
  const children = new Map<string, Set<Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>>>()
  const screenshots = new Map<string, { scale: number; x: number; y: number }>()
  const screenRevisions = new Map<string, number>()
  const needsObservation = new Set<string>()
  const namespace = createHash("sha256").update(kernel.paths.appData).digest("hex").slice(0, 10)
  const metadata = (botId: string) =>
    db.query("SELECT * FROM bot_machines WHERE bot_id = ?").get(botId) as Metadata | null
  const botFor = (botId: string): Bot => {
    const bot = kernel.services.use("store.api")?.getBot({ botId })
    if (bot?.machine !== "vm") throw new Error("Bot não usa VM")
    return bot
  }
  const memoryPreference = () => {
    const value = kernel.services.use("store.settings")?.().botVmMemoryMb
    return validBotVmMemory(value) ? value : DEFAULT_BOT_VM_MEMORY_MB
  }
  const stateFor = (botId: string): MachineState =>
    states.get(botId) ?? {
      botId,
      status: "stopped",
      progress: null,
      error: null,
      memoryMb: memoryPreference(),
      createdMs: metadata(botId)?.created_ms ?? null,
      startMs: metadata(botId)?.start_ms ?? null,
      connection: null,
    }
  const update = (botId: string, patch: Partial<MachineState>) => {
    const state = {
      ...stateFor(botId),
      ...(patch.status === "starting" || patch.status === "running" ? { pauseReason: null } : {}),
      ...(patch.error === null ? { errorCode: null } : {}),
      ...patch,
      ...(patch.connection
        ? {
            connection: {
              ...patch.connection,
              endpoints: { ...patch.connection.endpoints, browser: "" },
              ports: patch.connection.ports.map((port) => (port.guestPort === 9222 ? { ...port, url: "" } : port)),
            },
          }
        : {}),
    }
    states.set(botId, state)
    kernel.publish({ type: "machine.updated", machine: state })
    return state
  }
  const serial = async <T>(botId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = locks.get(botId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => (signal ? abortVmWait(signal, action) : action()))
    locks.set(botId, next)
    const cleanup = () => {
      if (locks.get(botId) === next) locks.delete(botId)
    }
    void next.then(cleanup, cleanup)
    // Cancellation also bounds time spent waiting in the queue. Keep its place
    // until the previous action exits so lifecycle mutations remain serialized.
    return signal ? abortVmWait(signal, () => next) : next
  }
  const guestAuthPath = (provider: string): string => {
    if (provider === "opencode") return "/workspace/.home/.local/share/opencode/auth.json"
    if (provider === "codex") return "/workspace/.home/.codex/auth.json"
    return "/workspace/.home/.claude/.credentials.json"
  }
  const authDir = (botId: string) =>
    join(kernel.paths.appData, "vm-auth", createHash("sha256").update(botId).digest("hex"))
  const stagedLoginKey = (botId: string) => `vm-staged-login:${botId}`
  const stagedLoginProviders = (botId: string): string[] => {
    const row = db.query("SELECT value_json FROM settings WHERE key = ?").get(stagedLoginKey(botId)) as {
      value_json: string
    } | null
    return row
      ? (JSON.parse(row.value_json) as string[]).filter(
          (provider) => provider === "codex" || provider === "claude" || provider === "opencode",
        )
      : []
  }
  const clearStagedCredentials = (botId: string): Promise<void> => {
    const pending = credentialCleanups.get(botId)
    if (pending) return pending
    const staged = stagedLoginProviders(botId)
    const meta = metadata(botId)
    if (!meta || !staged.length) return Promise.resolve()
    const cleanup = (async () => {
      const signal = AbortSignal.timeout(2000)
      const result = await abortVmWait(signal, () =>
        provider.exec({
          id: meta.vm_id,
          user: "1000",
          command: "rm",
          args: ["-f", ...staged.map((provider) => guestAuthPath(provider))],
          signal,
        }),
      )
      if (!result.success || result.code !== 0)
        throw new ProviderLoginError("Não foi possível revogar o login emprestado. Reinicie a máquina.")
      db.query("DELETE FROM settings WHERE key = ?").run(stagedLoginKey(botId))
    })()
    credentialCleanups.set(botId, cleanup)
    void cleanup
      .finally(() => {
        if (credentialCleanups.get(botId) === cleanup) credentialCleanups.delete(botId)
      })
      .catch(() => {})
    return cleanup
  }
  const revoke = (botId: string) => {
    liveStaging.delete(botId)
    void clearStagedCredentials(botId).catch(() => {})
    for (const name of ["codex.json", "claude.json", "opencode.json"])
      removePrivateFile({ root: kernel.paths.appData, path: join(authDir(botId), name) })
  }
  // Revoke any interrupted run's staging copy at sidecar boot.
  const rows = db.query("SELECT * FROM bot_machines").all() as Array<Metadata>
  for (const row of rows) {
    revoke(row.bot_id)
    const activity = persistedActivity(row.bot_id)
    if (activity === null) touch(row.bot_id)
    else touched.set(row.bot_id, activity)
    states.set(row.bot_id, stateFor(row.bot_id))
  }

  const execWithEnv = async (
    { botId, command, args = [], cwd = "/workspace", signal }: Parameters<VmRuntime["exec"]>[0],
    env: Record<string, string>,
  ): ReturnType<VmRuntime["exec"]> => {
    const meta = metadata(botId)
    if (!meta) return { success: false, errorCode: "NOT_FOUND", error: "Máquina não criada" }
    const result = await withActivity(botId, () =>
      vmStage({
        kernel,
        botId,
        stage: "exec",
        timeoutMs: limits.exec,
        timeoutMessage: `A execução na máquina não respondeu em ${limits.exec / 1000} s (${command})`,
        ...(signal ? { signal } : {}),
        action: (signal) => provider.exec({ id: meta.vm_id, command, args, cwd, user: "1000", env, signal }),
      }),
    )
    return result.success
      ? {
          ...result,
          stdout: kernel.redact(result.stdout).slice(0, 1_048_576),
          stderr: kernel.redact(result.stderr).slice(0, 1_048_576),
        }
      : { ...result, error: kernel.redact(result.error) }
  }
  const exec: VmRuntime["exec"] = (input) => execWithEnv(input, guestEnv)
  const providerExec: VmRuntime["exec"] = (input) =>
    execWithEnv(input, applyProviderPrivacy(guestEnv, cliTelemetryOff(kernel)))
  const writeFile: VmRuntime["writeFile"] = async ({ botId, path, content, signal }) => {
    if (!path.startsWith("/workspace/") || path.split("/").includes("..")) throw new Error("Caminho fora da VM")
    const meta = metadata(botId)
    if (!meta) throw new Error("Máquina não criada")
    await withActivity(botId, () =>
      vmStage({
        kernel,
        botId,
        stage: "exec",
        timeoutMs: limits.exec,
        timeoutMessage: "Não foi possível gravar arquivo na máquina em 30 s",
        ...(signal ? { signal } : {}),
        action: async (signal) => {
          const child = provider.spawn({
            id: meta.vm_id,
            command: "python3",
            args: ["-c", GUEST_WRITE_COMMAND, "/workspace", path],
            user: "1000",
            env: guestEnv,
          })
          if (!child.success) throw new Error(child.error)
          const cancel = () => child.kill("SIGKILL")
          signal.addEventListener("abort", cancel, { once: true })
          try {
            signal.throwIfAborted()
            const writer = child.stdin.getWriter()
            await writer.write(new TextEncoder().encode(content))
            await writer.close()
            const [outcome] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            if (outcome.code !== 0) throw new Error("Não foi possível gravar arquivo na VM")
          } finally {
            signal.removeEventListener("abort", cancel)
          }
        },
      }),
    )
  }
  const forwardPort: VmRuntime["forwardPort"] = ({ botId, guestPort, signal }) =>
    serial(
      botId,
      async () => {
        const meta = metadata(botId)
        if (!meta) throw new Error("Máquina não criada")
        const port = unwrap(await provider.forwardPort({ id: meta.vm_id, guestPort }))
        signal?.throwIfAborted()
        const connection = unwrap(await provider.connection({ id: meta.vm_id }))
        signal?.throwIfAborted()
        const mapped = connection.ports.find((mapping) => mapping.guestPort === guestPort)
        if (!mapped) throw new Error("Porta ausente no descritor da máquina")
        const current = connections.get(botId)
        if (current) current.connection = connection
        update(botId, { connection })
        return { hostPort: port.hostPort, url: mapped.url }
      },
      signal,
    )
  const stopResources = async (botId: string) => {
    for (const revokeToken of turnTokens.get(botId) ?? []) revokeToken()
    turnTokens.delete(botId)
    const session = connections.get(botId)
    bridges.get(botId)?.()
    bridges.delete(botId)
    connections.delete(botId)
    update(botId, { connection: null })
    for (const child of children.get(botId) ?? []) child.kill("SIGTERM")
    children.delete(botId)
    screenshots.delete(botId)
    revoke(botId)
    const meta = metadata(botId)
    if (meta && session)
      await exec({
        botId,
        command: "rm",
        args: ["-f", session.connection.bridge.connectionFile],
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
  }
  const waitReady = (botId: string, signal?: AbortSignal) =>
    vmStage({
      kernel,
      botId,
      stage: "ready",
      timeoutMs: limits.ready,
      timeoutMessage: `A máquina não ficou pronta em ${limits.ready / 1000} s: Xvfb não iniciou ou o guest não respondeu`,
      ...(signal ? { signal } : {}),
      action: async (signal) => {
        const meta = metadata(botId)
        if (!meta) throw new Error("Máquina não criada")
        while (true) {
          signal.throwIfAborted()
          const ready = await provider.exec({
            id: meta.vm_id,
            command: "/bin/sh",
            args: ["-c", GUEST_READY_COMMAND],
            user: "0",
            env: browserEnv,
            signal,
          })
          signal.throwIfAborted()
          if (ready.success && ready.code === 0) return
          if (!ready.success && isMachineServiceFailure(ready.errorCode)) unwrap(ready)
          const detail = ready.success ? ready.stderr : ready.error
          if (detail.includes("Xvfb")) throw new Error(`A máquina não ficou pronta: ${kernel.redact(detail)}`)
          await Bun.sleep(100)
        }
      },
    })
  const boot = async (botId: string, signal?: AbortSignal, applyFolders = false) => {
    const bot = botFor(botId)
    if (!capability.available) throw new Error(capability.reason ?? "sem virtualização neste host")
    let meta = metadata(botId)
    // Image/readiness checks on a warm idle VM are not a lifecycle transition.
    // Publishing "starting" here unmounts viewers and loses their explicit control request.
    if (stateFor(botId).status !== "running" || !connections.has(botId))
      update(botId, { status: "starting", error: null, progress: "Preparando máquina…" })
    try {
      const first = now()
      let imageEnsured = false
      const ensureImage = async () => {
        if (imageEnsured) return
        await provider.ensureImage({
          ...(signal ? { signal } : {}),
          progress: (progress) => {
            if (signal?.aborted) return
            update(botId, { progress: kernel.redact(progress) })
            kernel.log({
              level: "info",
              module: "vm",
              msg: "VM boot: imagem",
              data: { botId, progress: kernel.redact(progress) },
            })
          },
        })
        signal?.throwIfAborted()
        imageEnsured = true
      }
      if (!meta) {
        const id = `touri-${namespace}-${createHash("sha256").update(botId).digest("hex").slice(0, 20)}`
        meta = {
          bot_id: botId,
          vm_id: id,
          volume: `${id}-workspace`,
          project_id: null,
          folder_fingerprint: "",
          created_ms: null,
          start_ms: null,
        }
        db.query("INSERT INTO bot_machines(bot_id, vm_id, volume) VALUES (?, ?, ?)").run(botId, id, meta.volume)
        touch(botId)
      }
      let status = unwrap(await provider.status({ id: meta.vm_id, ...(signal ? { signal } : {}) })).status
      const folderFingerprint = botFolderFingerprint(bot)
      const foldersChanged =
        meta.folder_fingerprint !== folderFingerprint &&
        (!!meta.folder_fingerprint || !!bot.anyFolderAccess || !!bot.folders?.length)
      // Resolve and validate before touching the existing machine. A failed grant
      // never destroys a working VM. Viewer warmup does not apply pending changes.
      const validatedMounts = status === "missing" || applyFolders ? botFolderMounts(kernel, bot, hostHome) : null
      const hostMounts = status === "missing" || (applyFolders && foldersChanged) ? validatedMounts : null
      let memoryMb = memoryPreference()
      signal?.throwIfAborted()
      if (status !== "missing") {
        const inspected = unwrap(await provider.inspect({ id: meta.vm_id, ...(signal ? { signal } : {}) }))
        if (inspected.memoryMb !== undefined) memoryMb = inspected.memoryMb
        signal?.throwIfAborted()
        if (!imageMatches(inspected.image) || !dnsMatches(inspected.dns) || (applyFolders && foldersChanged)) {
          try {
            if (users.get(botId)) throw new Error("Máquina ocupada; aguarde os turnos antes de atualizar")
            const progress =
              applyFolders && foldersChanged
                ? "Aplicando as pastas do bot…"
                : "Atualizando a máquina para a versão nova…"
            update(botId, { status: "starting", progress })
            kernel.log({
              level: "info",
              module: "vm",
              msg: progress,
              data: { botId, stage: "upgrade", previousImage: inspected.image, image: BOT_IMAGE },
            })
            await ensureImage()
            await stopResources(botId)
            if (status === "running") unwrap(await provider.stop({ id: meta.vm_id }))
            signal?.throwIfAborted()
            let mounts = inspected.volumes.filter((mount) => !mount.target.startsWith("/run/touri-auth"))
            if (!mounts.some((mount) => mount.target === "/workspace")) {
              // A rootfs export does not contain mounted data. Refuse ambiguous
              // layouts instead of hiding or losing a nested workspace mount.
              if (mounts.some((mount) => mount.target === "/" || mount.target.startsWith("/workspace/")))
                throw new Error("Mounts do workspace não reconhecidos; arquivos e container original preservados")
              const migrated = unwrap(
                await provider.migrateWorkspace({
                  id: meta.vm_id,
                  path: join(kernel.paths.appData, "vm-workspaces", `${meta.vm_id}-${randomBytes(6).toString("hex")}`),
                  ...(signal ? { signal } : {}),
                }),
              )
              mounts = [...mounts, migrated]
            }
            signal?.throwIfAborted()
            meta.volume = JSON.stringify(hostMounts ? [...withoutHostFolderMounts(mounts), ...hostMounts] : mounts)
            db.query("UPDATE bot_machines SET volume = ? WHERE bot_id = ?").run(meta.volume, botId)
            unwrap(await provider.destroy({ id: meta.vm_id }))
            signal?.throwIfAborted()
            status = "missing"
          } finally {
            await provider.stopBuilder?.()
          }
        }
      }
      if (status === "missing") {
        await ensureImage()
        const mounts = hostMounts
          ? [...withoutHostFolderMounts(persistentMounts(meta)), ...hostMounts]
          : persistentMounts(meta)
        if (!mounts.some((mount) => mount.target === "/var/lib/touri-browser")) {
          mounts.push({ type: "volume", source: `${meta.vm_id}-browser`, target: "/var/lib/touri-browser" })
        }
        meta.volume = JSON.stringify(mounts)
        db.query("UPDATE bot_machines SET volume = ? WHERE bot_id = ?").run(meta.volume, botId)
        for (const mount of mounts)
          if (mount.type === "volume")
            unwrap(await provider.createVolume({ name: mount.source, ...(signal ? { signal } : {}) }))
        signal?.throwIfAborted()
        ensurePrivateDirectory({ root: kernel.paths.appData, path: authDir(botId) })
        unwrap(
          await provider.create({
            ...(signal ? { signal } : {}),
            name: meta.vm_id,
            image: BOT_IMAGE,
            dns: BOT_DNS,
            cpus: 2,
            memoryMb: memoryPreference(),
            cwd: "/workspace",
            env: guestEnv,
            entrypoint: "/usr/local/lib/touri/init.sh",
            args: [],
            volumes: mounts,
          }),
        )
        db.query("UPDATE bot_machines SET folder_fingerprint = ? WHERE bot_id = ?").run(
          hostMounts ? folderFingerprint : meta.folder_fingerprint,
          botId,
        )
        memoryMb = memoryPreference()
      }
      const start = now()
      signal?.throwIfAborted()
      // A guest may have been stopped outside this sidecar. Retire the old
      // outbound bridge before rotating its authentication on the next boot.
      if (status !== "running" || !connections.has(botId)) {
        update(botId, { status: "starting", progress: "Preparando máquina…" })
        await stopResources(botId)
      }
      if (status !== "running") unwrap(await provider.start({ id: meta.vm_id, ...(signal ? { signal } : {}) }))
      // The root boot policy is deny-all until init is complete. Apply the
      // requested policy afterwards so a concurrent init cannot overwrite it.
      await waitReady(botId, signal)
      const requestedPolicy = readEgressPolicy(kernel, botId)
      const activePolicy =
        status === "running"
          ? tightenEgressPolicy(readEgressPolicy(kernel, botId, true), requestedPolicy)
          : requestedPolicy
      await installEgressPolicy(
        provider,
        meta.vm_id,
        activePolicy,
        signal,
        providerHosts(botFor(botId)).concat(getApiRequiredHosts(kernel, botFor(botId).model)),
      )
      saveEgressPolicy(kernel, botId, activePolicy, true)
      if (!liveStaging.has(botId)) await clearStagedCredentials(botId)
      signal?.throwIfAborted()
      if (status !== "running" || !connections.has(botId)) {
        const vmId = meta.vm_id
        await vmStage({
          kernel,
          botId,
          stage: "auth",
          timeoutMs: limits.auth,
          timeoutMessage: "A conexão selada da máquina não ficou pronta a tempo",
          ...(signal ? { signal } : {}),
          action: async (signal) => {
            const key = await connectionKeys.rotate(vmId)
            try {
              signal.throwIfAborted()
              const token = randomBytes(32).toString("hex")
              const desktopPassword = randomBytes(6).toString("base64")
              const desktopPasswordFile = vncPasswordFile(desktopPassword).toString("base64")
              kernel.addRedactionValue(token)
              kernel.addRedactionValue(desktopPassword)
              kernel.addRedactionValue(desktopPasswordFile)
              kernel.addRedactionValue(key.toString("base64"))
              const connection = unwrap(await provider.connection({ id: vmId, authKeyId: connectionKeyId(key) }))
              await writeFile({
                botId,
                path: connection.bridge.connectionFile,
                content: sealConnection({ connection, token, key, desktopPasswordFile }),
                signal,
              })
              await configureBridge({ provider, connection, key, signal })
              signal.throwIfAborted()
              connections.set(botId, { connection, token, desktopPassword })
            } finally {
              key.fill(0)
            }
          },
        })
      }
      if (bot.projectId && meta.project_id !== bot.projectId) {
        const project = db.query("SELECT path FROM projects WHERE id = ?").get(bot.projectId) as { path: string } | null
        if (!project) throw new Error("Projeto não encontrado")
        update(botId, { progress: "Copiando commit Git para /workspace…" })
        const vmId = meta.vm_id
        await vmStage({
          kernel,
          botId,
          stage: "exec",
          timeoutMs: limits.exec,
          timeoutMessage: `A cópia do projeto para a máquina excedeu ${limits.exec / 1000} s`,
          ...(signal ? { signal } : {}),
          action: async (signal) => {
            const source = await copyProjectSnapshot({
              kernel,
              provider,
              vmId,
              botId,
              projectPath: project.path,
              exec,
              signal,
            })
            await writeFile({ botId, path: "/workspace/.touri/source.json", content: JSON.stringify(source), signal })
          },
        })
        signal?.throwIfAborted()
        db.query("UPDATE bot_machines SET project_id = ? WHERE bot_id = ?").run(bot.projectId, botId)
      }
      const startMs = now() - start
      const createdMs = meta.created_ms ?? now() - first
      db.query("UPDATE bot_machines SET created_ms = ?, start_ms = ? WHERE bot_id = ?").run(createdMs, startMs, botId)
      touch(botId)
      return update(botId, {
        status: "running",
        progress: null,
        error: null,
        memoryMb,
        startMs,
        createdMs,
        connection: connections.get(botId)?.connection ?? null,
      })
    } catch (error) {
      bridges.get(botId)?.()
      bridges.delete(botId)
      connections.delete(botId)
      throw error
    }
  }
  const ensure = async (botId: string, signal?: AbortSignal, applyFolders = false) => {
    try {
      return await withMachineServiceRecovery({
        action: () => boot(botId, signal, applyFolders),
        probe: async (signal) => {
          const meta = metadata(botId)
          // A machine not created yet is probed by retrying its boot under the same deadline.
          if (!meta) return
          unwrap(await provider.status({ id: meta.vm_id, signal }))
        },
        startService: () => provider.startService(),
        onWaiting: () =>
          update(botId, { status: "starting", progress: "Preparando o computador…", error: null, connection: null }),
        ...(signal ? { signal } : {}),
        ...(limits.service !== undefined ? { timeoutMs: limits.service } : {}),
      })
    } catch (error) {
      // A stopped preparation may finish rejecting after the explicit stop has published its state.
      if (signal?.aborted && stateFor(botId).status === "stopped") throw error
      const failure = machineErrorState(error)
      update(botId, {
        status: "error",
        connection: null,
        progress: null,
        ...failure,
        error: kernel.redact(failure.error),
      })
      throw error
    }
  }
  const acquire = async (
    { botId, signal, runningOnly = false }: Parameters<VmRuntime["acquire"]>[0],
    applyFolders = false,
  ): Promise<() => Promise<void>> => {
    acquiring.set(botId, (acquiring.get(botId) ?? 0) + 1)
    const prewarming = !runningOnly ? warming.get(botId)?.promise : undefined
    await vmStage({
      kernel,
      botId,
      stage: "boot",
      timeoutMs: limits.boot,
      timeoutMessage: `O início da máquina excedeu ${limits.boot / 1000} s`,
      ...(signal ? { signal } : {}),
      action: async (signal) => {
        // A queued turn shares the warmup's service deadline and failure.
        if (prewarming) await abortVmWait(signal, () => prewarming)
        return serial(
          botId,
          async () => {
            signal.throwIfAborted()
            // Check the image even when this sidecar believes the VM is warm.
            // Existing users hold a lease; only idle machines can be replaced.
            if (runningOnly) {
              const meta = metadata(botId)
              if (!meta || stateFor(botId).status !== "running" || !connections.has(botId))
                throw new Error("A máquina não está em execução")
              if (unwrap(await provider.status({ id: meta.vm_id, signal })).status !== "running")
                throw new Error("A máquina não está em execução")
            } else if (
              applyFolders &&
              users.get(botId) &&
              metadata(botId)?.folder_fingerprint !== botFolderFingerprint(botFor(botId)) &&
              (botFor(botId).anyFolderAccess || botFor(botId).folders?.length || metadata(botId)?.folder_fingerprint)
            ) {
              throw new Error("Aguarde os turnos terminarem para aplicar as pastas da máquina.")
            } else if (!users.get(botId) || stateFor(botId).status !== "running")
              await ensure(botId, signal, applyFolders)
            else await waitReady(botId, signal)
            signal.throwIfAborted()
            users.set(botId, (users.get(botId) ?? 0) + 1)
            touch(botId)
          },
          signal,
        )
      },
    })
      .catch((error) => {
        const failure = machineErrorState(error)
        // Canceling a viewer's acquisition does not stop an already running machine.
        if (!runningOnly && (!signal?.aborted || stateFor(botId).status !== "running"))
          update(botId, {
            status: signal?.aborted ? "stopped" : "error",
            progress: null,
            ...failure,
            error: kernel.redact(failure.error),
          })
        throw error
      })
      .finally(() => acquiring.set(botId, Math.max(0, (acquiring.get(botId) ?? 1) - 1)))
    let released = false
    return async () => {
      if (released) return
      released = true
      // Refcounts contain no awaits. Cleanup cannot wait behind a stalled port
      // forward or another bot operation when the user presses Stop.
      users.set(botId, Math.max(0, (users.get(botId) ?? 1) - 1))
      touch(botId)
      if (!users.get(botId)) revoke(botId)
      if (!users.get(botId) && parkRequested.has(botId))
        void serial(botId, () => park(botId)).catch((error) =>
          kernel.log({ level: "warn", module: "vm", msg: kernel.redact(String(error)) }),
        )
    }
  }
  const spawnGuest = (
    { botId, cmd, args, cwd, env }: Parameters<VmRuntime["spawn"]>[0],
    user: "1000" | "1001",
  ): ReturnType<VmRuntime["spawn"]> => {
    const meta = metadata(botId)
    if (!meta || stateFor(botId).status !== "running")
      return { success: false, errorCode: "SPAWN_FAILED", error: "VM parada" }
    const child = provider.spawn({
      id: meta.vm_id,
      command: cmd,
      args,
      cwd,
      env: { ...(user === "1001" ? browserEnv : guestEnv), ...env },
      user,
    })
    if (child.success) {
      const set = children.get(botId) ?? new Set()
      set.add(child)
      children.set(botId, set)
      touch(botId)
      void child.exited.then(
        () => {
          set.delete(child)
          // Provider exit notifications can arrive after the VM runtime releases
          // its database during shutdown. They must not write into a closed DB.
          if (!disposing) touch(botId)
        },
        () => {
          set.delete(child)
        },
      )
    }
    return child
  }
  const spawn: VmRuntime["spawn"] = (input) => spawnGuest(input, "1000")
  const stageCredential = async (
    bot: Bot,
    signal: AbortSignal,
  ): Promise<{ secrets: string[]; env: Record<string, string>; file?: string; selection?: string }> => {
    if (!liveStaging.has(bot.id)) await clearStagedCredentials(bot.id)
    if (bot.provider === "opencode" && bot.model?.startsWith("touri-api-")) return { secrets: [], env: {} }
    if (!bot.vmProviderLogin) return { secrets: [] as string[], env: {} as Record<string, string> }
    const login = await readProviderLogin(kernel, bot, hostHome, {
      signal,
      timeoutMs: Math.min(VAULT_READ_DEADLINE_MS, limits.auth / 2),
    })
    signal.throwIfAborted()
    const secrets: string[] = []
    kernel.addRedactionValue(login.value)
    const redactValues = (value: unknown): void => {
      if (typeof value === "string" && value.length >= 6) {
        kernel.addRedactionValue(value)
        secrets.push(value)
      } else if (typeof value === "object" && value) for (const item of Object.values(value)) redactValues(item)
    }
    if (login.source === "token") {
      redactValues(login.value)
      return { secrets, env: { CLAUDE_CODE_OAUTH_TOKEN: login.value }, selection: login.selection }
    }
    redactValues(JSON.parse(login.value))
    const path = join(authDir(bot.id), `${bot.provider}.json`)
    atomicWriteFile({ root: kernel.paths.appData, path, content: login.value })
    return { secrets, env: {} as Record<string, string>, file: login.value, selection: login.selection }
  }
  const prepareTurn: VmRuntime["prepareTurn"] = async ({ botId, threadId, token, signal }) => {
    if (!safeThreadId(threadId)) throw new Error("Thread inválida")
    kernel.addRedactionValue(token)
    const release = await acquire({ botId, ...(signal ? { signal } : {}) }, true)
    let credential: ReturnType<typeof createRunMcpToken> | undefined
    let tokenPath: string | undefined
    let released = false
    const releaseTurn = async () => {
      if (released) return
      released = true
      // Fence the host connection before awaiting any guest cleanup or lease release.
      credential?.revoke()
      if (credential) {
        const tokens = turnTokens.get(botId)
        tokens?.delete(credential.revoke)
        if (!tokens?.size) turnTokens.delete(botId)
      }
      if (botFor(botId).provider === "opencode") {
        // Use a fresh deadline: a canceled turn must still remove its private
        // auth copy from the persistent guest workspace.
        await exec({
          botId,
          command: "rm",
          args: ["-f", `/workspace/.home/.touri-opencode/${threadId}/data/opencode/auth.json`],
          signal: AbortSignal.timeout(2000),
        }).catch(() => {})
      }
      await release()
      if (tokenPath)
        await exec({ botId, command: "rm", args: ["-f", tokenPath], signal: AbortSignal.timeout(2000) }).catch(() => {})
    }
    try {
      const bot = botFor(botId)
      const mounted = metadata(botId)?.folder_fingerprint
      if ((mounted || bot.anyFolderAccess || bot.folders?.length) && mounted !== botFolderFingerprint(bot))
        throw new Error("As pastas mudaram durante a preparação. Inicie outro turno para aplicá-las.")
      const {
        secrets,
        env: loginEnv,
        selection: loginSelection,
      } = await vmStage({
        kernel,
        botId,
        threadId,
        stage: "auth",
        timeoutMs: limits.auth,
        timeoutMessage: `O login na máquina não ficou pronto em ${limits.auth / 1000} s.${bot.provider === "claude" ? " Abra as permissões do bot e salve um token gerado com claude setup-token em Entrar no Claude nesta máquina; depois tente novamente." : ""}`,
        ...(signal ? { signal } : {}),
        action: async (signal) => {
          const credential = await stageCredential(bot, signal)
          const authPath = guestAuthPath(bot.provider)
          if (bot.vmProviderLogin && !bot.model?.startsWith("touri-api-") && !credential.env.CLAUDE_CODE_OAUTH_TOKEN) {
            if (!credential.file) throw new ProviderLoginError("Login de arquivo ausente")
            if (credential.selection !== providerLoginSource(kernel, bot))
              throw new ProviderLoginError("A fonte de login mudou. Tente novamente.")
            db.query(
              "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            ).run(
              stagedLoginKey(botId),
              JSON.stringify([...new Set([...stagedLoginProviders(botId), bot.provider])]),
              now(),
            )
            await writeFile({ botId, path: authPath, content: credential.file, signal })
            liveStaging.add(botId)
            // Verify the private credential is readable by the agent uid.
            const readable = await exec({ botId, command: "test", args: ["-r", authPath], signal })
            if (!readable.success)
              throw new ProviderLoginError(
                `O arquivo de login do ${bot.provider === "opencode" ? "OpenCode" : bot.provider === "claude" ? "Claude" : "Codex"} não ficou acessível na VM. Pare a máquina e tente novamente; se persistir, reconecte o provedor nas permissões do bot.`,
              )
          } else
            await exec({
              botId,
              command: "/bin/sh",
              args: ["-c", 'if test -L "$1"; then rm -f "$1"; fi', "touri", authPath],
              signal,
            })
          if (!bot.vmProviderLogin && bot.provider !== "opencode") {
            const login = await providerExec({
              botId,
              command: bot.provider,
              args: bot.provider === "claude" ? ["auth", "status"] : ["login", "status"],
              signal,
            })
            if (!login.success)
              throw new ProviderLoginError(
                `${bot.provider === "claude" ? "Claude" : "Codex"} não está conectado nesta máquina. Abra as permissões do bot para entrar.`,
              )
          }
          if (bot.vmProviderLogin && (!botFor(bot.id).vmProviderLogin || botFor(bot.id).provider !== bot.provider))
            throw new ProviderLoginError("A permissão de login mudou. Tente novamente.")
          if (credential.selection && credential.selection !== providerLoginSource(kernel, bot))
            throw new ProviderLoginError("A fonte de login mudou. Tente novamente.")
          return credential
        },
      })
      update(botId, { error: null })
      await vmStage({
        kernel,
        botId,
        threadId,
        stage: "exec",
        timeoutMs: limits.exec,
        timeoutMessage: `A preparação do CLI na máquina excedeu ${limits.exec / 1000} s`,
        ...(signal ? { signal } : {}),
        action: async (signal) => {
          credential = createRunMcpToken(kernel, threadId, token)
          const tokens = turnTokens.get(botId) ?? new Set<() => void>()
          tokens.add(credential.revoke)
          turnTokens.set(botId, tokens)
          tokenPath = `/workspace/.touri/run/${threadId}.${credential.tokenId}.token`
          // These independent guest operations must finish before the CLI starts.
          // Overlap process startup instead of paying for three host/guest round trips in sequence.
          await Promise.all([
            writeFile({ botId, path: tokenPath, content: token, signal }),
            writeFile({ botId, path: "/workspace/.home/SOUL.md", content: bot.instructions, signal }),
            (async () => {
              if (bridges.has(botId)) return
              const session = connections.get(botId)
              if (!session) throw new Error("Conexão da máquina ausente")
              const port = await forwardPort({ botId, guestPort: session.connection.bridge.guestPort, signal })
              signal.throwIfAborted()
              bridges.set(
                botId,
                connectMcpBridge({
                  port: port.hostPort,
                  transport: port.url,
                  token: session.token,
                  socketPath: resolveMcpEndpoint(kernel.paths),
                }),
              )
            })(),
          ])
        },
      })
      signal?.throwIfAborted()
      if (!tokenPath) throw new Error("Token MCP do turno ausente")
      return {
        bot: { ...bot, homeDir: "/workspace/.home", cwd: "/workspace" },
        cwd: "/workspace",
        env: applyProviderPrivacy({ ...guestEnv, ...loginEnv }, cliTelemetryOff(kernel)),
        mcp: {
          command: "/usr/local/bin/node",
          args: ["/usr/local/lib/touri/mcp-stdio.cjs", threadId, tokenPath],
          env: {},
        },
        execution: {
          connect: async (port) => (await forwardPort({ botId, guestPort: port, ...(signal ? { signal } : {}) })).url,
          wrapEvents: (emit) => redactVmEvents({ secrets, redact: kernel.redact, emit }),
          spawn: (input) => {
            if (
              bot.vmProviderLogin &&
              (!botFor(bot.id).vmProviderLogin ||
                botFor(bot.id).provider !== bot.provider ||
                providerLoginSource(kernel, bot) !== loginSelection)
            )
              return {
                success: false,
                errorCode: "SPAWN_FAILED",
                error: "A fonte ou permissão de login mudou. Tente novamente.",
              }
            if (signal?.aborted) return { success: false, errorCode: "SPAWN_FAILED", error: "Turno cancelado" }
            kernel.log({
              level: "info",
              module: "vm",
              msg: "VM exec: iniciando CLI",
              data: { botId, threadId, command: input.cmd },
            })
            const child = spawn({ botId, ...input })
            if (child.success) {
              const cancel = () => child.kill("SIGKILL")
              signal?.addEventListener("abort", cancel, { once: true })
              void child.exited.finally(() => signal?.removeEventListener("abort", cancel)).catch(() => {})
              let firstByte = false
              const observe = () =>
                new TransformStream<Uint8Array, Uint8Array>({
                  transform(chunk, controller) {
                    if (!firstByte && chunk.length) {
                      firstByte = true
                      kernel.log({
                        level: "info",
                        module: "vm",
                        msg: "VM exec: primeira saída do CLI",
                        data: { botId, threadId },
                      })
                    }
                    controller.enqueue(chunk)
                  },
                })
              return {
                ...child,
                stdout: child.stdout.pipeThrough(observe()),
                stderr: child.stderr.pipeThrough(observe()),
              }
            } else
              kernel.log({
                level: "error",
                module: "vm",
                msg: "VM exec: CLI falhou",
                data: { botId, threadId, error: kernel.redact(child.error) },
              })
            return child
          },
          writeFile: (input) => writeFile({ botId, ...input, ...(signal ? { signal } : {}) }),
        },
        release: releaseTurn,
      }
    } catch (error) {
      await releaseTurn()
      const failure = machineErrorState(error)
      update(botId, { ...failure, error: kernel.redact(failure.error), progress: null })
      throw error
    }
  }
  const restart: VmRuntime["restart"] = ({ botId, reset = false, projectId }) =>
    serial(botId, async () => {
      if (users.get(botId)) throw new Error("Máquina ocupada; pare os turnos antes de reiniciar")
      if (
        projectId !== undefined &&
        (!reset ||
          (projectId !== null &&
            !db.query("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL").get(projectId)))
      )
        throw new Error("Projeto inválido para recriação")
      update(botId, { status: "stopped" })
      await stopResources(botId)
      const meta = metadata(botId)
      if (meta) {
        const status = unwrap(await provider.status({ id: meta.vm_id })).status
        if (status === "running") unwrap(await provider.stop({ id: meta.vm_id }))
        if (reset) {
          if (status !== "missing") unwrap(await provider.destroy({ id: meta.vm_id }))
          for (const mount of persistentMounts(meta))
            if (mount.type === "volume") unwrap(await provider.deleteVolume({ name: mount.source }))
          db.query("DELETE FROM bot_machines WHERE bot_id = ?").run(botId)
          states.delete(botId)
          db.query(
            "UPDATE provider_sessions SET state = 'replaced' WHERE thread_id IN (SELECT id FROM threads WHERE bot_id = ?) AND state = 'active'",
          ).run(botId)
        }
      }
      if (reset && projectId !== undefined) {
        db.query("UPDATE bots SET project_id = ?, updated_at = ? WHERE id = ?").run(projectId, now(), botId)
        kernel.publish({ type: "bot.updated", bot: botFor(botId) })
      }
      update(botId, { status: "stopped" })
      return vmStage({
        kernel,
        botId,
        stage: "boot",
        timeoutMs: limits.boot,
        timeoutMessage: "A máquina não respondeu ao reinício",
        action: (signal) => ensure(botId, signal),
      })
    })
  const destroy: VmRuntime["destroy"] = ({ botId, deleteVolumes = true }) =>
    serial(botId, async () => {
      if (users.get(botId)) throw new TouriError("TOURI-E8004")
      await stopResources(botId)
      const meta = metadata(botId)
      if (meta) {
        const status = unwrap(await provider.status({ id: meta.vm_id })).status
        if (status === "running") unwrap(await provider.stop({ id: meta.vm_id }))
        if (status !== "missing") unwrap(await provider.destroy({ id: meta.vm_id }))
        const volumes = persistentMounts(meta)
          .filter((mount) => mount.type === "volume")
          .map((mount) => mount.source)
        if (deleteVolumes) {
          const shared = (db.query("SELECT * FROM bot_machines WHERE bot_id != ?").all(botId) as Array<Metadata>)
            .flatMap(persistentMounts)
            .map((mount) => mount.source)
          for (const volume of volumes)
            if (!shared.includes(volume)) unwrap(await provider.deleteVolume({ name: volume }))
        } else if (volumes.length) {
          db.query("INSERT OR REPLACE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run(
            `retained-vm-volumes:${botId}`,
            JSON.stringify(volumes),
            now(),
          )
        }
        db.query("DELETE FROM bot_machines WHERE bot_id = ?").run(botId)
        await connectionKeys.remove(meta.vm_id)
      }
      rmSync(authDir(botId), { recursive: true, force: true })
      states.delete(botId)
    })
  const park = async (botId: string) => {
    const request = parkRequested.get(botId)
    const requested = () => {
      if (!request || parkRequested.get(botId) !== request || leased(botId)) return false
      return now() - lastActivity(botId) >= botFor(botId).machineIdleMinutes * 60_000
    }
    if (!requested()) return stateFor(botId)
    const meta = metadata(botId)
    if (!meta || unwrap(await provider.status({ id: meta.vm_id })).status !== "running") {
      if (parkRequested.get(botId) === request) parkRequested.delete(botId)
      return stateFor(botId)
    }
    if (!requested()) return stateFor(botId)
    update(botId, { status: "stopped", connection: null, progress: null })
    try {
      await stopResources(botId)
      unwrap(await provider.stop({ id: meta.vm_id }))
      kernel.log({
        level: "info",
        module: "vm",
        msg: "Máquina pausada por inatividade",
        data: { botId, intent: request?.intent },
      })
    } catch (error) {
      update(botId, { status: "error", error: kernel.redact(String(error)) })
      throw error
    }
    if (parkRequested.get(botId) === request) parkRequested.delete(botId)
    return update(botId, {
      status: "stopped",
      connection: null,
      progress: null,
      error: null,
      pauseReason: "inactivity",
    })
  }
  const intent: VmRuntime["intent"] = async ({ botId, intent, viewerId }) => {
    const bot = botFor(botId)
    if (intent === "computer-visible" || intent === "computer-hidden") {
      if (!viewerId || !/^[a-zA-Z0-9-]{1,80}$/.test(viewerId)) throw new Error("Identificador do visualizador inválido")
      const presence = viewers.get(botId) ?? new Map<string, number>()
      if (intent === "computer-visible") {
        presence.set(viewerId, now() + 120_000)
      } else presence.delete(viewerId)
      if (presence.size) viewers.set(botId, presence)
      else viewers.delete(botId)
      touch(botId)
      return stateFor(botId)
    }
    if (intent === "foreground") {
      parkRequested.delete(botId)
      touch(botId)
      return stateFor(botId)
    }
    if (intent === "background" || intent === "idle") {
      // Blur/APP_BACKGROUND is only visibility information. It must not become
      // a deferred stop that survives new turns, prewarming or a Preview close.
      if (intent === "background" || now() - lastActivity(botId) < bot.machineIdleMinutes * 60_000)
        return stateFor(botId)
      parkRequested.set(botId, { intent })
      return serial(botId, () => park(botId))
    }
    if (bot.paused || bot.archivedAt !== null) return stateFor(botId)
    parkRequested.delete(botId)
    touch(botId)
    const pending = warming.get(botId)
    if (pending) return pending.promise
    const controller = new AbortController()
    const warm = vmStage({
      kernel,
      botId,
      stage: "boot",
      timeoutMs: limits.boot,
      timeoutMessage: "O aquecimento da máquina excedeu o tempo limite",
      signal: controller.signal,
      action: (signal) =>
        serial(
          botId,
          async () => {
            if (stateFor(botId).status !== "running" || !connections.has(botId)) await ensure(botId, signal)
            return stateFor(botId)
          },
          signal,
        ),
    }).finally(() => {
      if (warming.get(botId)?.promise === warm) warming.delete(botId)
    })
    warming.set(botId, { promise: warm, controller })
    return warm
  }
  const stop: VmRuntime["stop"] = ({ botId }) => {
    warming.get(botId)?.controller.abort()
    return serial(botId, async () => {
      if (users.get(botId)) throw new Error("Máquina ocupada; pare os turnos antes de alterar a configuração")
      parkRequested.delete(botId)
      update(botId, { status: "stopped", progress: null, error: null, pauseReason: null })
      try {
        await stopResources(botId)
        const meta = metadata(botId)
        if (meta && unwrap(await provider.status({ id: meta.vm_id })).status === "running")
          unwrap(await provider.stop({ id: meta.vm_id }))
      } catch (error) {
        const failure = machineErrorState(error)
        update(botId, { status: "error", ...failure, error: kernel.redact(failure.error) })
        throw error
      }
    })
  }
  const startService: VmRuntime["startService"] = ({ botId }) => {
    if (botId) botFor(botId)
    if (!capability.available) throw new Error(capability.reason ?? "sem virtualização neste host")
    const key = botId ?? ""
    const pending = serviceStarts.get(key)
    if (pending) return pending
    const started = (async () => {
      if (botId && stateFor(botId).status !== "running")
        update(botId, { status: "starting", progress: "Iniciando serviço de máquinas…", error: null })
      try {
        unwrap(await provider.startService())
        if (!botId) return null
        // Reuse normal preparation; starting the service must not restart a running guest.
        const release = await acquire({ botId })
        await release()
        return stateFor(botId)
      } catch (error) {
        if (botId) {
          const failure = machineErrorState(error)
          update(botId, { status: "error", progress: null, ...failure, error: kernel.redact(failure.error) })
        }
        throw error
      }
    })().finally(() => {
      serviceStarts.delete(key)
    })
    serviceStarts.set(key, started)
    return started
  }
  let disposing: Promise<void> | null = null
  const getMachines = async function* (stage: "vm_idle_sweep" | "vm_orphan_sweep") {
    const measure = getMeasuredStage(stage, runStage)
    let cursor = 0
    // Orphan protection follows machines registered while it yields; idle work uses a fixed snapshot.
    const upper =
      stage === "vm_idle_sweep"
        ? (measure(() => db.query("SELECT COALESCE(MAX(rowid),0) AS cursor FROM bot_machines").get()) as {
            cursor: number
          })
        : null
    const getRows = (after: number) => {
      if (!upper)
        return measure(() =>
          db
            .query(`SELECT rowid AS scan_cursor,* FROM bot_machines
          WHERE rowid>? ORDER BY rowid LIMIT 50`)
            .all(after),
        )

      return measure(() =>
        db
          .query(`SELECT rowid AS scan_cursor,* FROM bot_machines
        WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 50`)
          .all(after, upper.cursor),
      )
    }
    while (!disposing) {
      const rows = getRows(cursor) as Array<Metadata & { scan_cursor: number }>
      if (!rows.length) return

      yield* rows
      cursor = rows.at(-1)?.scan_cursor ?? cursor
      await yieldBackground()
    }
  }
  const sweepIdle = async () => {
    if (disposing) return
    for await (const row of getMachines("vm_idle_sweep"))
      await serial(row.bot_id, async () => {
        const bot = kernel.services.use("store.api")?.getBot({ botId: row.bot_id })
        if (disposing || leased(row.bot_id) || !bot) return
        if (
          isIdle({
            now: now(),
            lastActivityAt: lastActivity(row.bot_id),
            idleMs: bot.machineIdleMinutes * 60_000,
          }) &&
          !parkRequested.has(row.bot_id)
        )
          parkRequested.set(row.bot_id, { intent: "idle" })
        await park(row.bot_id)
      })
  }
  const idleTask = createBackgroundTask("vm_idle_sweep", sweepIdle, runStage)
  const sweep = idleTask.run
  const browserEndpoint: VmRuntime["browserEndpoint"] = ({ botId, runningOnly = false, signal }) =>
    vmStage({
      kernel,
      botId,
      stage: "browser",
      timeoutMs: 30_000,
      timeoutMessage: "O navegador da VM não respondeu em 30 s. Tente novamente.",
      ...(signal ? { signal } : {}),
      action: async (signal) => {
        if (runningOnly && stateFor(botId).status !== "running") return null
        const release = await acquire({ botId, runningOnly, signal })
        try {
          const meta = metadata(botId)
          if (!meta) throw new Error("Máquina ausente")
          const probe = await provider.exec({
            id: meta.vm_id,
            user: "0",
            command: "curl",
            args: ["-fsS", "--max-time", "1", "http://127.0.0.1:9222/json/version"],
            signal,
          })
          const launched = !probe.success || probe.code !== 0
          if (launched) {
            if (runningOnly) return null
            unwrap(
              await provider.exec({
                id: meta.vm_id,
                user: "0",
                command: "python3",
                args: ["-c", CLEAR_STALE_PROFILE_LOCKS_COMMAND],
                signal,
              }),
            )
            unwrap(
              await provider.exec({
                id: meta.vm_id,
                command: "sh",
                args: ["-c", BROWSER_LAUNCH_SHELL, "chromium", ...BROWSER_FLAGS],
                user: "1001",
                env: browserEnv,
                detach: true,
                signal,
              }),
            )
          }
          signal.throwIfAborted()
          const guestExec = async (command: string): Promise<{ ok: boolean; out: string }> => {
            const result = await provider.exec({
              id: meta.vm_id,
              user: "0",
              command: "sh",
              args: ["-c", command],
              signal,
            })
            return { ok: result.success && result.code === 0, out: result.success ? result.stdout : "" }
          }
          const port = await forwardPort({ botId, guestPort: 9222, signal })
          const deadline = Date.now() + BROWSER_START_BUDGET_MS
          for (let attempt = 0; Date.now() < deadline; attempt++) {
            try {
              signal.throwIfAborted()
              const response = await fetch(`${port.url}/json/version`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
              })
              const info = (await response.json()) as { webSocketDebuggerUrl: string }
              signal.throwIfAborted()
              const url = new URL(info.webSocketDebuggerUrl)
              url.hostname = "127.0.0.1"
              url.port = String(port.hostPort)
              const endpoint = new URL(port.url)
              url.pathname = `${endpoint.pathname}${url.pathname}`
              return url.toString()
            } catch {
              signal.throwIfAborted()
              if (launched && attempt % BROWSER_LIVENESS_EVERY === BROWSER_LIVENESS_EVERY - 1) {
                const running = await guestExec(BROWSER_RUNNING_COMMAND)
                if (!running.ok) {
                  const log = await guestExec(BROWSER_LOG_TAIL_COMMAND)
                  throw new BrowserStartError("exited", browserStartMessage({ reason: "exited", detail: log.out }))
                }
              }
              await abortVmWait(signal, () => Bun.sleep(100))
            }
          }
          const log = await guestExec(BROWSER_LOG_TAIL_COMMAND)
          await guestExec(BROWSER_STOP_COMMAND)
          throw new BrowserStartError("unresponsive", browserStartMessage({ reason: "unresponsive", detail: log.out }))
        } finally {
          await release()
        }
      },
    })
  const computerOperation: VmRuntime["computer"] = async ({ ctx, name, args }): Promise<ToolResult> => {
    const bot = botFor(ctx.botId)
    const observationRevision = screenRevisions.get(ctx.botId) ?? 0
    const writes = !["computer_screenshot", "computer_frontmost"].includes(name)
    if (!bot.computerUse) return { success: false, errorCode: "COMPUTER_DISABLED", error: "Computer use desativado" }
    if (ctx.signal.aborted) return { success: false, errorCode: "DEADLINE_EXCEEDED", error: "Operação cancelada" }
    const release = await acquire({ botId: ctx.botId, signal: ctx.signal })
    try {
      ctx.signal.throwIfAborted()
      const currentBot = botFor(ctx.botId)
      if (!currentBot.computerUse)
        return { success: false, errorCode: "COMPUTER_DISABLED", error: "Computer use desativado" }
      if (writes && currentBot.access === "read-only")
        return { success: false, errorCode: "DENIED", error: "O bot está em modo somente leitura." }
      if (writes && needsObservation.has(ctx.botId))
        return {
          success: false,
          errorCode: "COMPUTER_NO_SCREENSHOT",
          error: "A tela pode ter mudado durante seu controle. Observe novamente antes de continuar.",
        }
      const input = { ...((args as Record<string, unknown>) ?? {}) }
      if (["computer_click", "computer_scroll"].includes(name)) {
        const map = screenshots.get(ctx.botId)
        if (!map)
          return {
            success: false,
            errorCode: "COMPUTER_NO_SCREENSHOT",
            error: "Use computer_screenshot antes das coordenadas",
          }
        input.x = map.x + Number(input.x) / map.scale
        input.y = map.y + Number(input.y) / map.scale
      }
      const child = spawnGuest(
        {
          botId: ctx.botId,
          cmd: "python3",
          args: ["/usr/local/lib/touri/computer.py"],
          cwd: "/workspace",
          env: browserEnv,
        },
        "1001",
      )
      if (!child.success) return child
      const cancel = () => child.kill("SIGTERM")
      ctx.signal.addEventListener("abort", cancel, { once: true })
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ name, args: input })}\n`))
      await writer.close()
      const [stdout, , outcome] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      ctx.signal.removeEventListener("abort", cancel)
      if (outcome.code !== 0)
        return { success: false, errorCode: "VM_COMPUTER_ERROR", error: "Falha ao operar display Xvfb da VM" }
      const result = JSON.parse(stdout) as { data?: string; scale: number; region?: { x: number; y: number } }
      if (name === "computer_screenshot" && result.data) {
        if (
          observationRevision === (screenRevisions.get(ctx.botId) ?? 0) &&
          !kernel.services.use("computer.input")?.human(ctx.botId)
        ) {
          screenshots.set(ctx.botId, { scale: result.scale, x: result.region?.x ?? 0, y: result.region?.y ?? 0 })
          needsObservation.delete(ctx.botId)
        }
        return {
          success: true,
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
          structured: { ...result, data: undefined, display: "vm:Xvfb :99" },
        }
      }
      return {
        success: true,
        content: [{ type: "text", text: "Operação no display da VM concluída" }],
        structured: result,
      }
    } finally {
      await release()
    }
  }
  const computer: VmRuntime["computer"] = (input) => {
    const gate = kernel.services.use("computer.input")
    const writes = !["computer_screenshot", "computer_frontmost"].includes(input.name)
    if (!writes) return computerOperation(input)
    if (!gate)
      return Promise.resolve({ success: false, errorCode: "COMPUTER_DISABLED", error: "Controle indisponível" })
    return gate.run(input.ctx, (signal) => computerOperation({ ...input, ctx: { ...input.ctx, signal } }))
  }
  const service: VmRuntime = {
    capability,
    states: () =>
      (db.query("SELECT id FROM bots WHERE machine = 'vm' AND archived_at IS NULL").all() as Array<{ id: string }>).map(
        ({ id }) => stateFor(id),
      ),
    intent,
    holdViewer: (botId) => {
      botFor(botId)
      const count = connectedViewers.get(botId) ?? 0
      if (count >= 32) throw new Error("Muitos visualizadores abertos para este bot")
      connectedViewers.set(botId, count + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const remaining = Math.max(0, (connectedViewers.get(botId) ?? 1) - 1)
        if (remaining) connectedViewers.set(botId, remaining)
        else connectedViewers.delete(botId)
        touch(botId)
      }
    },
    acquire,
    exec,
    spawn,
    writeFile,
    forwardPort,
    desktopConnection: async ({ botId, signal }) => {
      const session = connections.get(botId)
      if (!session) throw new Error("Conexão da tela indisponível")
      const port = await forwardPort({ botId, guestPort: 5900, ...(signal ? { signal } : {}) })
      if (connections.get(botId) !== session) throw new Error("Conexão da tela expirada")
      return { ...port, password: session.desktopPassword }
    },
    prepareTurn,
    restart,
    startService,
    stop,
    destroy,
    browserEndpoint,
    computer,
    doctor: () => provider.doctor(),
  }
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "desktop.control") {
      screenRevisions.set(event.botId, (screenRevisions.get(event.botId) ?? 0) + 1)
      needsObservation.add(event.botId)
      screenshots.delete(event.botId)
    }
    if (event.type === "bot.updated" && !event.bot.vmProviderLogin) revoke(event.bot.id)
  })
  const timer = setInterval(() => {
    void sweep().catch((error) => kernel.log({ level: "warn", module: "vm", msg: kernel.redact(String(error)) }))
  }, 30_000)
  timer.unref()
  const orphanTask = createBackgroundTask(
    "vm_orphan_sweep",
    async () => {
      if (!provider.sweepOrphans) return

      // Only local accumulators change while yielding; the provider needs the
      // complete protected-volume set before it can decide which volumes to remove.
      const protectedVolumes: string[] = []
      for await (const meta of getMachines("vm_orphan_sweep")) {
        protectedVolumes.push(
          ...persistentMounts(meta)
            .filter((mount) => mount.type === "volume")
            .map((mount) => mount.source),
        )
      }
      let cursor = "retained-vm-volumes:"
      const measure = getMeasuredStage("vm_orphan_sweep", runStage)
      while (!disposing) {
        const rows = measure(() =>
          db
            .query(`SELECT key,value_json FROM settings
        WHERE key>? AND key<'retained-vm-volumes;' ORDER BY key LIMIT 50`)
            .all(cursor),
        ) as Array<{
          key: string
          value_json: string
        }>
        if (!rows.length) break

        rows.forEach((row) => {
          protectedVolumes.push(...(JSON.parse(row.value_json) as string[]))
        })
        cursor = rows.at(-1)?.key ?? cursor
        await yieldBackground()
      }
      if (disposing) return

      await provider.sweepOrphans({ protectedVolumes })
    },
    runStage,
  )
  const sweepOrphans = orphanTask.run
  const orphanTimer = setInterval(() => {
    if (!capability.available) return
    void sweepOrphans().catch((error) =>
      kernel.log({
        level: "warn",
        module: "vm",
        msg: "VM_ORPHAN_SWEEP_FAILED",
        data: { error: kernel.redact(String(error)) },
      }),
    )
  }, 60 * 60_000)
  orphanTimer.unref()
  const dispose = (): Promise<void> => {
    if (disposing) return disposing
    disposing = (async () => {
      unsubscribe()
      clearInterval(timer)
      clearInterval(orphanTimer)
      idleTask.dispose()
      orphanTask.dispose()
      await Promise.allSettled(locks.values())
      for (const row of db.query("SELECT * FROM bot_machines").all() as Array<Metadata>) {
        await stopResources(row.bot_id)
        const status = await provider.status({ id: row.vm_id })
        if (status.success && status.status === "running") await provider.stop({ id: row.vm_id })
      }
    })()
    return disposing
  }
  const reconcile = async () => {
    for (const row of rows) {
      const status = await provider.status({ id: row.vm_id })
      if (status.success)
        update(row.bot_id, { status: status.status === "running" ? "running" : "stopped", connection: null })
      else update(row.bot_id, { status: "error", error: kernel.redact(status.error) })
    }
  }
  const applyNetworkPolicy = async (botId: string) => {
    await serial(botId, async () => {
      const meta = metadata(botId)
      if (!meta || stateFor(botId).status !== "running") return
      const policy = tightenEgressPolicy(readEgressPolicy(kernel, botId, true), readEgressPolicy(kernel, botId))
      try {
        await installEgressPolicy(
          provider,
          meta.vm_id,
          policy,
          undefined,
          providerHosts(botFor(botId)).concat(getApiRequiredHosts(kernel, botFor(botId).model)),
        )
        saveEgressPolicy(kernel, botId, policy, true)
      } catch (error) {
        await stopResources(botId)
        update(botId, { status: "error", error: String(error) })
        throw error
      }
    })
  }
  const paste = async ({ botId, text, signal }: { botId: string; text: string; signal: AbortSignal }) => {
    const meta = metadata(botId)
    if (!meta || stateFor(botId).status !== "running") throw new Error("Máquina parada")
    const result = await provider.exec({
      id: meta.vm_id,
      user: "1001",
      command: "python3",
      args: ["-c", clipboard, text],
      env: browserEnv,
      signal,
    })
    if (!result.success || result.code !== 0) throw new Error("Falha na colagem")
  }
  return { service, sweep, sweepOrphans, dispose, reconcile, applyNetworkPolicy, paste }
}
