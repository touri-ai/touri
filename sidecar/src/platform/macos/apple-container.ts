import { BOT_BOOT_COMMAND, CANCEL_VM_PROCESS_COMMAND, VM_PROCESS_COMMAND } from "../../vm/guest-process"

export { BOT_BOOT_COMMAND, CANCEL_VM_PROCESS_COMMAND, VM_PROCESS_COMMAND } from "../../vm/guest-process"

import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, statfsSync } from "node:fs"
import { cp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withToolPath } from "../../kernel/shell-env"
import { spawnTree } from "../../kernel/spawn"
import { commandError, createVmCommandRunner, type VmCommandRunner } from "../../vm/command"
import { machineConnection } from "../../vm/connection"
import { vmDoctor } from "../../vm/doctor"
import { BOT_IMAGE, imageContext } from "../../vm/image"
import { containerMemoryMb } from "../../vm/inventory"
import { createContainerMaintenance, defaultVmWarning, type VmWarning } from "../../vm/maintenance"
import { createPrivateForwarding } from "../../vm/private-forwarding"
import { isMachineServiceFailure, MachineServiceError } from "../../vm/service-error"
import type {
  VmConnectionRef,
  VmCreateOptions,
  VmExecOptions,
  VmInspection,
  VmPortForward,
  VmProvider,
  VmRef,
  VmResult,
  VmSnapshot,
  VmStatus,
  VmVolumeSpec,
} from "../../vm/types"
import { validatedVolumeMounts } from "../../vm/volume-mounts"

type JsonRecord = Record<string, unknown>

type AppleContainerProviderOptions = {
  binary?: string
  runCommand?: VmCommandRunner
  dataDir?: string
  warn?: VmWarning
  availableDiskBytes?: (path: string) => number
}

const defaultBinary = (): string => Bun.which("container", { PATH: withToolPath().PATH }) ?? "container"

const record = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null ? (value as JsonRecord) : null

const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

const validName = (name: string): boolean => /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535

const validateCreateOptions = ({ options }: { options: VmCreateOptions }): string | null => {
  if (!validName(options.name)) return "VM name must match [a-z0-9][a-z0-9_.-]{0,62}"
  if (options.image.trim().length === 0) return "VM image is required"
  if (options.cpus !== undefined && (!Number.isInteger(options.cpus) || options.cpus < 1))
    return "VM CPU count must be a positive integer"
  if (options.memoryMb !== undefined && (!Number.isInteger(options.memoryMb) || options.memoryMb < 128))
    return "VM memory must be at least 128 MiB"
  if (options.ports?.length) return "Use authenticated forwarding instead of published ports"
  for (const port of options.ports ?? []) {
    if (!validPort(port.guestPort) || !validPort(port.hostPort)) return "VM ports must be between 1 and 65535"
    if (port.hostIp !== undefined && port.hostIp !== "127.0.0.1") return "VM forwarding must bind to 127.0.0.1"
  }
  return null
}

const envArgs = (env: Record<string, string> | undefined): Array<string> =>
  Object.entries(env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`])

const portArgs = (ports: VmCreateOptions["ports"]): Array<string> =>
  (ports ?? []).flatMap((port) => [
    "--publish",
    `${port.hostIp ?? "127.0.0.1"}:${port.hostPort}:${port.guestPort}/${port.protocol ?? "tcp"}`,
  ])

const volumeArgs = (volumes: VmCreateOptions["volumes"]): Array<string> =>
  (volumes ?? []).flatMap((volume) => [
    "--mount",
    `type=${volume.type ?? "bind"},source=${volume.source},target=${volume.target}${volume.readOnly ? ",readonly" : ""}`,
  ])

const statusFromValue = (value: unknown): VmStatus | null => {
  const text = stringValue(value)?.toLowerCase()
  if (!text) return null
  if (text.includes("running") || text.includes("started")) return "running"
  if (text.includes("created") || text.includes("new")) return "created"
  if (text.includes("stopped") || text.includes("exited") || text.includes("dead")) return "stopped"
  return "unknown"
}

const statusFromRecord = (value: JsonRecord): VmStatus => {
  const direct = statusFromValue(value.status) ?? statusFromValue(value.state)
  if (direct) return direct
  const nested = record(value.status) ?? record(value.state)
  if (nested) {
    const nestedStatus = statusFromValue(nested.status) ?? statusFromValue(nested.state)
    if (nestedStatus) return nestedStatus
  }
  return "unknown"
}

const listEntries = (value: unknown): Array<JsonRecord> => {
  if (Array.isArray(value)) return value.flatMap((item) => (record(item) ? [record(item) as JsonRecord] : []))
  const root = record(value)
  if (!root) return []
  for (const key of ["containers", "items", "data"]) {
    if (Array.isArray(root[key])) return listEntries(root[key])
  }
  return [root]
}

const entryMatches = ({ entry, id }: { entry: JsonRecord; id: string }): boolean =>
  [entry.id, entry.name, entry.identifier, record(entry.configuration)?.id].some((candidate) => candidate === id)

const refFor = ({ id, name }: { id: string; name: string }): VmRef => ({ id, name, provider: "apple-container" })

export const createAppleContainerProvider = ({
  binary = defaultBinary(),
  runCommand = createVmCommandRunner({ binary }),
  dataDir = tmpdir(),
  warn = defaultVmWarning,
  availableDiskBytes = (path) => {
    const disk = statfsSync(path)
    return disk.bavail * disk.bsize
  },
}: AppleContainerProviderOptions = {}): VmProvider => {
  const maintenance = createContainerMaintenance({ run: runCommand, warn })
  const keyIds = new Map<string, string>()
  const forwarding = createPrivateForwarding({ spawn: (options) => provider.spawn(options) })
  const portsByVm = forwarding.portsByVm
  const forgetVm = (id: string) => {
    forwarding.forgetVm(id)
    keyIds.delete(id)
  }
  let imageBuild: Promise<void> | null = null
  let serviceStart: Promise<VmResult<object>> | null = null
  const command = async ({
    args,
    action,
    signal,
    timeoutMs,
  }: {
    args: Array<string>
    action: string
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<VmResult<{ output: Awaited<ReturnType<VmCommandRunner>> }>> => {
    const output = await runCommand(args, { ...(signal ? { signal } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
    if (output.code !== 0) return commandError({ output, action })
    return { success: true, output }
  }

  const provider: VmProvider = {
    name: "apple-container",
    sweepOrphans: (input) => maintenance.sweepOrphans(input.protectedVolumes),
    stopBuilder: async () => {
      await imageBuild?.catch(() => undefined)
      await maintenance.stopBuilder()
    },

    startService() {
      if (serviceStart) return serviceStart
      serviceStart = (async (): Promise<VmResult<object>> => {
        const status = await runCommand(["system", "status"])
        if (status.code === 0) return { success: true }
        const started = await runCommand(["system", "start"])
        // A concurrent manual start may make `start` fail with "already running".
        const verified = await runCommand(["system", "status"])
        if (verified.code !== 0)
          return {
            success: false,
            errorCode: "MACHINE_SERVICE_START_FAILED",
            error: started.code === 0 ? verified.stderr : started.stderr,
          }
        return { success: true }
      })().finally(() => {
        serviceStart = null
      })
      return serviceStart
    },

    spawn(options) {
      const pidFile = `/tmp/touri-${randomUUID()}.pid`
      const child = spawnTree({
        cmd: binary,
        cwd: tmpdir(),
        env: withToolPath(),
        args: [
          "exec",
          "--interactive",
          ...(options.user ? ["--user", options.user] : []),
          ...(options.cwd ? ["--cwd", options.cwd] : []),
          ...envArgs(options.env),
          options.id,
          "setsid",
          "--wait",
          "python3",
          "-c",
          VM_PROCESS_COMMAND,
          pidFile,
          options.command,
          ...(options.args ?? []),
        ],
      })
      if (!child.success) return child
      return {
        ...child,
        kill(signal) {
          // Killing the host container CLI alone can leave the guest process alive.
          // Stop the local wait immediately; guest cleanup must not gate cancellation.
          child.kill(signal)
          void runCommand([
            "exec",
            options.id,
            "node",
            "-e",
            CANCEL_VM_PROCESS_COMMAND,
            pidFile,
            signal,
            options.user ?? "0",
          ]).catch(() => {})
        },
      }
    },

    async createVolume({ name, signal }) {
      const existing = await runCommand(["volume", "inspect", name], { ...(signal ? { signal } : {}) })
      if (existing.code === 0) return { success: true, name }
      const result = await command({
        args: ["volume", "create", "--label", "touri.vm=true", "-s", "20G", name],
        action: "volume create",
        ...(signal ? { signal } : {}),
      })
      return result.success ? { success: true, name } : result
    },
    async deleteVolume({ name }) {
      const existing = await runCommand(["volume", "inspect", name])
      if (existing.code !== 0 && /notFound|not found|does not exist/i.test(existing.stderr))
        return { success: true, name }
      const result = await command({ args: ["volume", "delete", name], action: "volume delete" })
      return result.success ? { success: true, name } : result
    },
    async ensureImage({ progress, signal }) {
      const inspected = await runCommand(["image", "inspect", BOT_IMAGE], { ...(signal ? { signal } : {}) })
      if (inspected.code === 0) return
      const failure = commandError({ output: inspected, action: "image inspect" })
      if (isMachineServiceFailure(failure.errorCode)) throw new MachineServiceError(failure.errorCode, failure.error)
      if (availableDiskBytes(dataDir) < 12 * 1024 ** 3)
        throw new Error(`São necessários 12 GiB livres para construir a imagem ${BOT_IMAGE}; libere o cache do builder`)
      if (!imageBuild)
        imageBuild = (async () => {
          progress("Construindo imagem: Node 22, CLIs, Chromium e Xvfb…")
          const context = await imageContext(tmpdir())
          const child = spawnTree({
            cmd: binary,
            args: [
              "build",
              "--dns",
              "1.1.1.1",
              "--cpus",
              "2",
              "--memory",
              "1536M",
              "--progress",
              "plain",
              "--tag",
              BOT_IMAGE,
              context,
            ],
            cwd: tmpdir(),
            env: withToolPath(),
          })
          if (!child.success) throw new Error(child.error)
          const cancel = () => child.kill("SIGKILL")
          signal?.addEventListener("abort", cancel, { once: true })
          const consume = async (stream: ReadableStream<Uint8Array>) => {
            const reader = stream.getReader()
            const decoder = new TextDecoder()
            while (true) {
              const next = await reader.read()
              if (next.done) break
              progress(decoder.decode(next.value, { stream: true }).trim().slice(-400))
            }
          }
          try {
            signal?.throwIfAborted()
            const output = Promise.all([consume(child.stdout), consume(child.stderr)])
            const outcome = await child.exited
            // Builder descendants can retain the build pipes after the CLI exits.
            await maintenance.stopBuilder()
            await output
            if (outcome.code !== 0) throw new Error("Falha ao construir imagem da máquina")
          } finally {
            signal?.removeEventListener("abort", cancel)
          }
        })().finally(async () => {
          try {
            await maintenance.stopBuilder()
          } finally {
            imageBuild = null
          }
        })
      await imageBuild
    },
    doctor: () => vmDoctor(runCommand, dataDir),

    async connection({ id, authKeyId }) {
      for (const guestPort of [9876, 9222]) {
        const result = await provider.forwardPort({ id, guestPort })
        if (!result.success) return result
      }
      if (authKeyId) keyIds.set(id, authKeyId)
      return {
        success: true,
        ...machineConnection({
          id,
          provider: provider.name,
          ports: [...(portsByVm.get(id)?.values() ?? [])],
          authKeyId: keyIds.get(id) ?? null,
        }),
      }
    },

    async create(options): Promise<VmResult<VmConnectionRef>> {
      const validationError = validateCreateOptions({ options })
      if (validationError) return { success: false, errorCode: "INVALID_CONFIG", error: validationError }
      let volumes: VmVolumeSpec[]
      try {
        volumes = validatedVolumeMounts(options.volumes)
      } catch {
        return {
          success: false,
          errorCode: "INVALID_CONFIG",
          error: "Pasta de origem ou destino da montagem inválido.",
        }
      }
      const botInit = options.entrypoint === "/usr/local/lib/touri/init.sh"
      const args = [
        "create",
        "--name",
        options.name,
        "--label",
        "touri.vm=true",
        "--label",
        `touri.vm.name=${options.name}`,
        "--init",
        ...(botInit ? ["--cap-add", "CAP_NET_ADMIN"] : []),
        "--entrypoint",
        botInit ? "/usr/bin/python3" : (options.entrypoint ?? "/bin/sh"),
        ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
        ...(options.memoryMb === undefined ? [] : ["--memory", `${options.memoryMb}M`]),
        ...(options.cwd === undefined ? [] : ["--cwd", options.cwd]),
        ...envArgs(options.env),
        ...portArgs(options.ports),
        ...volumeArgs(volumes),
        ...(options.dns ?? []).flatMap((server) => ["--dns", server]),
        options.image,
        ...(botInit ? ["-c", BOT_BOOT_COMMAND] : (options.args ?? ["-c", "while :; do sleep 3600; done"])),
      ]
      const result = await command({
        args,
        action: "container create",
        timeoutMs: 120_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!result.success) return result
      const ports = new Map<number, VmPortForward>()
      for (const port of options.ports ?? []) {
        ports.set(port.guestPort, {
          guestPort: port.guestPort,
          hostPort: port.hostPort,
          hostIp: port.hostIp ?? "127.0.0.1",
          protocol: port.protocol ?? "tcp",
        })
      }
      portsByVm.set(options.name, ports)
      const resultConnection = await provider.connection({ id: options.name })
      if (!resultConnection.success) return resultConnection
      const { success, ...connection } = resultConnection
      return { success, ...refFor({ id: options.name, name: options.name }), connection }
    },

    async start({ id, signal }): Promise<VmResult<VmConnectionRef>> {
      // The boot entrypoint cleans /tmp before starting Xvfb, not after it has
      // acquired a live lock. Apple Container cannot exec in a stopped guest.
      const result = await command({ args: ["start", id], action: "container start", ...(signal ? { signal } : {}) })
      if (!result.success) return result
      const resultConnection = await provider.connection({ id })
      if (!resultConnection.success) return resultConnection
      const { success, ...connection } = resultConnection
      return { success, ...refFor({ id, name: id }), connection }
    },

    async stop({ id }): Promise<VmResult<VmRef>> {
      forgetVm(id)
      const result = await command({ args: ["stop", "--time", "5", id], action: "container stop" })
      if (!result.success) return result
      return { success: true, ...refFor({ id, name: id }) }
    },

    async exec(options: VmExecOptions): Promise<VmResult<Awaited<ReturnType<VmCommandRunner>>>> {
      if (options.command.trim().length === 0)
        return { success: false, errorCode: "INVALID_CONFIG", error: "VM command is required" }
      const result = await command({
        args: [
          "exec",
          ...(options.detach === true ? ["--detach"] : []),
          ...(options.user ? ["--user", options.user] : []),
          ...(options.cwd === undefined ? [] : ["--cwd", options.cwd]),
          ...envArgs(options.env),
          options.id,
          options.command,
          ...(options.args ?? []),
        ],
        action: "container exec",
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!result.success) return result
      return { success: true, ...result.output }
    },

    forwardPort: (input) => forwarding.forwardPort(input),

    async snapshot({ id, path }): Promise<VmResult<VmSnapshot>> {
      if (path.trim().length === 0)
        return { success: false, errorCode: "INVALID_CONFIG", error: "Snapshot path is required" }
      const result = await runCommand(["export", "--output", path, id])
      if (result.code !== 0)
        return {
          success: false,
          errorCode: "SNAPSHOT_FAILED",
          error:
            result.stderr.trim().replace(/\s+/g, " ").slice(0, 1000) || `Snapshot failed with exit code ${result.code}`,
        }
      return { success: true, id, path: join(path) }
    },

    async destroy({ id }): Promise<VmResult<{ id: string }>> {
      forgetVm(id)
      const result = await command({ args: ["delete", "--force", id], action: "container delete" })
      if (!result.success) return result
      return { success: true, id }
    },

    async status({ id, signal }): Promise<VmResult<{ id: string; status: VmStatus }>> {
      let result = await runCommand(["list", "--all", "--format", "json"], { ...(signal ? { signal } : {}) })
      for (let attempt = 0; attempt < 2 && result.code !== 0 && /XPC timeout/i.test(result.stderr); attempt++) {
        await Bun.sleep(200)
        signal?.throwIfAborted()
        result = await runCommand(["list", "--all", "--format", "json"], { ...(signal ? { signal } : {}) })
      }
      if (result.code !== 0) return commandError({ output: result, action: "container list" })
      let parsed: unknown
      try {
        parsed = JSON.parse(result.stdout) as unknown
      } catch {
        return { success: false, errorCode: "STATUS_FAILED", error: "container list returned invalid JSON" }
      }
      const entry = listEntries(parsed).find((candidate) => entryMatches({ entry: candidate, id }))
      if (!entry) return { success: true, id, status: "missing" }
      return { success: true, id, status: statusFromRecord(entry) }
    },

    async inspect({ id, signal }): Promise<VmResult<VmInspection>> {
      const result = await command({
        args: ["inspect", id],
        action: "container inspect",
        ...(signal ? { signal } : {}),
      })
      if (!result.success) return result
      try {
        const entry = listEntries(JSON.parse(result.output.stdout)).find((entry) => entryMatches({ entry, id }))
        const config = record(entry?.configuration)
        const image = stringValue(record(config?.image)?.reference)
        if (!image || !Array.isArray(config?.mounts)) throw new Error("Imagem ou mounts ausentes no inspect")
        const volumes = config.mounts.map((value): VmVolumeSpec => {
          const mount = record(value)
          const type = record(mount?.type)
          const volume = record(type?.volume)
          const source = stringValue(volume ? volume.name : mount?.source)
          const target = stringValue(mount?.destination)
          if (!source || !target || (!volume && !record(type?.virtiofs)))
            throw new Error("Mount desconhecido; atualização cancelada para preservar os arquivos")
          return {
            type: volume ? "volume" : "bind",
            source,
            target,
            readOnly: Array.isArray(mount?.options) && mount.options.includes("ro"),
          }
        })
        const nameservers = record(config?.dns)?.nameservers
        const dns = (Array.isArray(nameservers) ? (nameservers as unknown[]) : [])
          .map((value) => stringValue(value))
          .filter((value): value is string => Boolean(value))
        const memoryMb = entry ? containerMemoryMb(entry) : null
        return { success: true, image, volumes, dns, ...(memoryMb !== null ? { memoryMb } : {}) }
      } catch (error) {
        return { success: false, errorCode: "STATUS_FAILED", error: `container inspect: ${String(error)}` }
      }
    },

    migrateWorkspace({ id, path, signal }): Promise<VmResult<VmVolumeSpec>> {
      return maintenance.withMigration(async (): Promise<VmResult<VmVolumeSpec>> => {
        // Export works for stopped guests as well. Keep the complete backup even
        // if extraction or recreation fails; never delete the source on failure.
        await mkdir(path, { recursive: true, mode: 0o700 })
        const archive = join(path, "rootfs.tar")
        const exported = await command({
          args: ["export", "--output", archive, id],
          action: "workspace backup",
          ...(signal ? { signal } : {}),
        })
        if (!exported.success) return exported
        const tar = createVmCommandRunner({ binary: "/usr/bin/tar", timeoutMs: 300_000 })
        const extracted = await tar(["-xf", archive, "-C", path, "workspace", "home/node"], {
          ...(signal ? { signal } : {}),
        })
        if (extracted.code !== 0) return commandError({ output: extracted, action: "workspace migration" })
        const workspace = join(path, "workspace")
        const home = join(path, "home/node")
        if (!existsSync(workspace) || lstatSync(workspace).isSymbolicLink())
          return {
            success: false,
            errorCode: "INVALID_CONFIG",
            error: "Workspace inválido; container original preservado",
          }
        if (!lstatSync(home).isSymbolicLink()) {
          const persistentHome = join(workspace, ".home")
          if (existsSync(persistentHome) && lstatSync(persistentHome).isSymbolicLink())
            return {
              success: false,
              errorCode: "INVALID_CONFIG",
              error: "Home inválido; container original preservado",
            }
          await cp(home, persistentHome, { recursive: true, force: false, dereference: false })
        }
        // A macOS bind cannot chown files to the guest uid. Copy into a named
        // volume in a disposable helper before deleting the original rootfs.
        const helper = `touri-migrate-${randomUUID()}`
        const volume = `${helper}-data`
        const stored = await provider.createVolume({ name: volume, ...(signal ? { signal } : {}) })
        if (!stored.success) return stored
        try {
          const created = await provider.create({
            name: helper,
            image: BOT_IMAGE,
            cpus: 1,
            memoryMb: 512,
            entrypoint: "/bin/sh",
            cwd: "/",
            volumes: [
              { type: "bind", source: path, target: "/source", readOnly: true },
              { type: "volume", source: volume, target: "/workspace" },
            ],
            ...(signal ? { signal } : {}),
          })
          if (!created.success) return created
          const started = await provider.start({ id: helper, ...(signal ? { signal } : {}) })
          if (!started.success) return started
          const copied = await provider.exec({
            id: helper,
            command: "cp",
            args: ["-a", "/source/workspace/.", "/workspace/"],
            ...(signal ? { signal } : {}),
          })
          if (!copied.success) return copied
          const owned = await provider.exec({
            id: helper,
            command: "chown",
            args: ["-hR", "1000:1000", "/workspace"],
            ...(signal ? { signal } : {}),
          })
          if (!owned.success) return owned
          maintenance.retainVolume(volume)
          return { success: true, type: "volume", source: volume, target: "/workspace" }
        } finally {
          await maintenance.destroyHelper(helper)
          forgetVm(helper)
        }
      })
    },
  }

  return provider
}
