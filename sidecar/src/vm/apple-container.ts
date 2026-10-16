import { randomUUID } from "node:crypto"
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, statfsSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { spawnTree } from "../kernel/spawn"
import { commandError, createVmCommandRunner, type VmCommandRunner } from "./command"
import { machineConnection } from "./connection"
import { vmDoctor } from "./doctor"
import { BOT_IMAGE, imageContext } from "./image"
import { containerMemoryMb } from "./inventory"
import { capabilityListener, privateSocket } from "./local-transport"
import { createContainerMaintenance, defaultVmWarning, type VmWarning } from "./maintenance"
import { isMachineServiceFailure, MachineServiceError } from "./service-error"
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
} from "./types"

type JsonRecord = Record<string, unknown>

type AppleContainerProviderOptions = {
  binary?: string
  runCommand?: VmCommandRunner
  dataDir?: string
  warn?: VmWarning
  availableDiskBytes?: (path: string) => number
}

const defaultBinary = (): string => Bun.which("container") ?? "container"

// Run before the image's init on EVERY start, even with an older bot image.
// Python expands paths in the guest; no shell interpolation or unresolved globs.
export const BOT_BOOT_COMMAND = `import os, pathlib
for pattern in (".X*-lock", ".X11-unix/X*", "touri-ready", "touri-init-error"):
    for path in pathlib.Path("/tmp").glob(pattern):
        path.unlink(missing_ok=True)
os.execv("/usr/local/lib/touri/init.sh", ["/usr/local/lib/touri/init.sh"])
`

export const VM_PROCESS_COMMAND = `import os,sys,json,secrets
parent=os.open(os.path.dirname(sys.argv[1]),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
name=os.path.basename(sys.argv[1]);temporary='.'+name+'.'+secrets.token_hex(16)
fd=None
try:
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
 started=open('/proc/self/stat').read().rsplit(')',1)[1].split()[19] if os.path.exists('/proc/self/stat') else ''
 data=json.dumps(dict(pid=os.getpid(),started=started)).encode()
 if os.write(fd,data)!=len(data): raise OSError('short process marker')
 os.fsync(fd);os.close(fd);fd=None
 os.link(temporary,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
 os.fsync(parent)
finally:
 if fd is not None: os.close(fd)
 try: os.unlink(temporary,dir_fd=parent)
 except FileNotFoundError: pass
 os.close(parent)
if os.path.lexists(sys.argv[1]+'.cancel'): sys.exit(130)
os.execvpe(sys.argv[2],sys.argv[2:],os.environ)`

// Publish cancellation before reading the marker: cancellation before launch
// cannot leave a late guest process running. Match uid/start time before kill.
export const CANCEL_VM_PROCESS_COMMAND = `const fs=require('node:fs');
const path=process.argv[1];
try{const fd=fs.openSync(path+'.cancel',fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);fs.closeSync(fd)}catch{}
try{
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let job,owner;try{const info=fs.fstatSync(fd);if(!info.isFile())process.exit(0);owner=info.uid;job=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}
 if(!Number.isSafeInteger(job.pid)||job.pid<2)process.exit(0);
 const raw=fs.readFileSync('/proc/'+job.pid+'/stat','utf8');const stat=raw.slice(raw.lastIndexOf(')')+1).trim().split(/\\s+/);
 const uid=Number(fs.readFileSync('/proc/'+job.pid+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)?.[1]);
 const requested=(process.argv[3]||'0').split(':')[0];const expected=/^\\d+$/.test(requested)?Number(requested):Number(fs.readFileSync('/etc/passwd','utf8').split('\\n').find(line=>line.startsWith(requested+':'))?.split(':')[2]);
 if(String(stat[19])===job.started&&Number(stat[2])===job.pid&&uid===expected&&owner===expected)process.kill(-job.pid,process.argv[2]);
}catch{}`

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

const configuredPort = ({
  ports,
  guestPort,
  hostPort,
}: {
  ports: Map<number, VmPortForward>
  guestPort: number
  hostPort?: number
}): VmResult<VmPortForward> => {
  const configured = ports.get(guestPort)
  if (!configured)
    return {
      success: false,
      errorCode: "PORT_NOT_CONFIGURED",
      error: `Port ${guestPort} was not declared when the container was created; recreate it with ports[]`,
    }
  if (hostPort !== undefined && configured.hostPort !== hostPort)
    return {
      success: false,
      errorCode: "PORT_NOT_CONFIGURED",
      error: `Port ${guestPort} is forwarded to ${configured.hostPort}, not ${hostPort}`,
    }
  return { success: true, ...configured }
}

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
  const portsByVm = new Map<string, Map<number, VmPortForward>>()
  const proxies = new Map<string, Map<number, { close: () => void }>>()
  const proxySockets = new Map<string, Set<Socket>>()
  const keyIds = new Map<string, string>()
  const forgetVm = (id: string) => {
    for (const socket of proxySockets.get(id) ?? []) socket.destroy()
    proxySockets.delete(id)
    for (const server of proxies.get(id)?.values() ?? []) server.close()
    proxies.delete(id)
    portsByVm.delete(id)
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
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
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
              imageContext(tmpdir()),
            ],
            cwd: tmpdir(),
            env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
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
        volumes = (options.volumes ?? []).map((mount) => {
          if (
            !mount.target.startsWith("/") ||
            mount.target.split("/").includes("..") ||
            /[\0\n\r,]/.test(mount.target) ||
            /[\0\n\r,]/.test(mount.source)
          )
            throw new Error("Invalid volume path")
          if (mount.type === "volume") return mount
          if (!isAbsolute(mount.source)) throw new Error("Bind source must be absolute")
          const source = realpathSync(mount.source)
          // Managed host grants arrive canonical. Refuse a retargeted ancestor
          // or symlink between validation and container creation; OS aliases
          // such as /var -> /private/var are the only spelling exception.
          const expected =
            process.platform === "darwin"
              ? resolve(mount.source).replace(/^\/(var|tmp|etc)(?=\/|$)/, "/private/$1")
              : resolve(mount.source)
          if ((mount.target === "/host" || mount.target.startsWith("/host/")) && source !== expected)
            throw new Error("Host folder changed after validation")
          return { ...mount, source }
        })
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

    async forwardPort({ id, guestPort, hostPort }): Promise<VmResult<VmPortForward>> {
      if (!validPort(guestPort) || (hostPort !== undefined && !validPort(hostPort)))
        return { success: false, errorCode: "INVALID_CONFIG", error: "Invalid port" }
      const ports = portsByVm.get(id) ?? new Map<number, VmPortForward>()
      portsByVm.set(id, ports)
      if (ports.has(guestPort))
        return hostPort === undefined
          ? configuredPort({ ports, guestPort })
          : configuredPort({ ports, guestPort, hostPort })
      const relay = (socket: Socket, initial?: Buffer) => {
        const sockets = proxySockets.get(id) ?? new Set<Socket>()
        sockets.add(socket)
        proxySockets.set(id, sockets)
        socket.once("close", () => sockets.delete(socket))
        const child = provider.spawn({ id, command: "socat", args: ["STDIO", `TCP:127.0.0.1:${guestPort}`] })
        if (!child.success) return socket.destroy()
        const writer = child.stdin.getWriter()
        if (initial) void writer.write(initial).catch(() => socket.destroy())
        socket.on("data", (chunk) => {
          if (socket.destroyed) return
          socket.pause()
          void writer
            .write(chunk)
            .then(() => socket.resume())
            .catch(() => socket.destroy())
        })
        socket.on("error", () => socket.destroy())
        socket.on("close", () => {
          void writer.close().catch(() => {})
          child.kill("SIGTERM")
        })
        void child.stdout
          .pipeTo(
            new WritableStream({
              write: (chunk) =>
                new Promise<void>((resolve, reject) => {
                  socket.write(chunk, (error) => (error ? reject(error) : resolve()))
                }),
            }),
          )
          .catch(() => socket.destroy())
        void new Response(child.stderr).text()
        void child.exited.then(() => socket.destroy())
      }
      const servers = proxies.get(id) ?? new Map<number, { close: () => void }>()
      proxies.set(id, servers)
      try {
        let mapping: VmPortForward
        if ([9876, 5900].includes(guestPort)) {
          if (hostPort !== undefined) throw new Error("Private control channel")
          const socket = privateSocket()
          const server = createServer(relay)
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject)
            server.listen(socket.path, resolve)
          })
          servers.set(guestPort, {
            close: () => {
              server.close()
              socket.remove()
            },
          })
          mapping = { guestPort, hostPort: 0, hostIp: "127.0.0.1", protocol: "tcp", url: `unix:${socket.path}` }
        } else {
          const proxy = await capabilityListener(relay, hostPort)
          servers.set(guestPort, proxy)
          mapping = { guestPort, hostPort: proxy.hostPort, hostIp: "127.0.0.1", protocol: "tcp", url: proxy.url }
        }
        ports.set(guestPort, mapping)
        return { success: true, ...mapping }
      } catch {
        return { success: false, errorCode: "COMMAND_FAILED", error: "Could not bind private forwarding channel" }
      }
    },

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
        mkdirSync(path, { recursive: true, mode: 0o700 })
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
          cpSync(home, persistentHome, { recursive: true, force: false, dereference: false })
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
