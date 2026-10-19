import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildChildEnv } from "../kernel/shell-env"
import { spawnTree } from "../kernel/spawn"
import { commandError, createVmCommandRunner, type VmCommandRunner } from "../vm/command"
import { machineConnection } from "../vm/connection"
import { BOT_BOOT_COMMAND, CANCEL_VM_PROCESS_COMMAND, VM_PROCESS_COMMAND } from "../vm/guest-process"
import { BOT_IMAGE, imageContext } from "../vm/image"
import { createPrivateForwarding } from "../vm/private-forwarding"
import type { VmExecOptions, VmProvider, VmResult, VmVolumeSpec } from "../vm/types"
import { validatedVolumeMounts } from "../vm/volume-mounts"
import { probeOciService, WINDOWS_VM_FIX } from "./oci-health"

export type OciEngine = "podman" | "docker"
const validName = (name: string) => /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)
const envArgs = (env: Record<string, string> = {}) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])
const execArgs = (options: VmExecOptions) => [
  "exec",
  ...(options.detach ? ["--detach"] : []),
  ...(options.user ? ["--user", options.user] : []),
  ...(options.cwd ? ["--workdir", options.cwd] : []),
  ...envArgs(options.env),
  options.id,
]

/** Rootless Podman is preferred. Never starts daemons, uses sudo, mounts engine sockets or publishes guest ports. */
export const createOciProvider = ({
  engine,
  binary = Bun.which(engine) ?? engine,
  dataDir = tmpdir(),
  run = createVmCommandRunner({ binary }),
  platform = process.platform,
}: {
  engine: OciEngine
  binary?: string
  dataDir?: string
  run?: VmCommandRunner
  platform?: string
}): VmProvider => {
  const forwarding = createPrivateForwarding({ spawn: (options) => provider.spawn(options) })
  const keys = new Map<string, string>()
  const ref = (id: string) => ({ id, name: id, provider: engine })
  const command = async (
    args: string[],
    signal?: AbortSignal,
  ): Promise<VmResult<{ output: Awaited<ReturnType<VmCommandRunner>> }>> => {
    const output = await run(args, signal ? { signal } : {})
    return output.code === 0 ? { success: true, output } : commandError({ output, action: `${engine} ${args[0]}` })
  }
  const info = () => probeOciService({ engine, platform, run })
  let imageBuild: Promise<void> | null = null
  const provider: VmProvider = {
    name: engine,
    async startService() {
      const output = await info()
      return output.code === 0
        ? { success: true }
        : {
            success: false,
            errorCode: "MACHINE_SERVICE_UNAVAILABLE",
            error:
              platform === "win32"
                ? WINDOWS_VM_FIX
                : `${engine} unavailable; check rootless user namespaces or start Docker Desktop. Use local bots meanwhile.`,
          }
    },
    async doctor() {
      const output = await info()
      const image = output.code === 0 ? await run(["image", "inspect", BOT_IMAGE]) : null
      return [
        {
          id: "vm-system",
          ok: output.code === 0,
          detail:
            output.code === 0
              ? `${engine} ready`
              : platform === "win32"
                ? WINDOWS_VM_FIX
                : `${engine} unavailable; check rootless user namespaces / daemon. Local bots are available.`,
          fix: output.code === 0 ? null : platform === "win32" ? WINDOWS_VM_FIX : `Run ${engine} info in your terminal`,
        },
        {
          id: "vm-image",
          ok: image?.code === 0,
          detail: image?.code === 0 ? `${BOT_IMAGE} cached` : "The bot image will be built on first use",
          fix: null,
        },
      ]
    },
    async ensureImage({ progress, signal }) {
      if ((await run(["image", "inspect", BOT_IMAGE], signal ? { signal } : {})).code === 0) return
      imageBuild ??= (async () => {
        progress(`Building ${BOT_IMAGE} with ${engine}…`)
        // The same source image, CLIs, display services and fail-closed nft policy as macOS.
        const context = await imageContext(dataDir)
        const output = await run(["build", "--file", join(context, "Containerfile"), "--tag", BOT_IMAGE, context], {
          ...(signal ? { signal } : {}),
          timeoutMs: 1_800_000,
        })
        if (output.code !== 0) throw new Error(`Bot image build failed: ${output.stderr.slice(-1000)}`)
        progress("Bot image ready")
      })().finally(() => {
        imageBuild = null
      })
      await imageBuild
    },
    async create(options) {
      if (
        !validName(options.name) ||
        !options.image.trim() ||
        options.image.startsWith("-") ||
        options.ports?.length ||
        (options.cpus !== undefined && (!Number.isInteger(options.cpus) || options.cpus < 1)) ||
        (options.memoryMb !== undefined && (!Number.isInteger(options.memoryMb) || options.memoryMb < 128)) ||
        options.volumes?.some((v) => /[,\0]/.test(v.source + v.target))
      )
        return {
          success: false,
          errorCode: "INVALID_CONFIG",
          error: "Invalid container configuration; use private forwarding, never published ports",
        }
      let volumes: VmVolumeSpec[]
      try {
        volumes = validatedVolumeMounts(options.volumes, { platform, managedOnly: true })
      } catch {
        return {
          success: false,
          errorCode: "INVALID_CONFIG",
          error: "Invalid volume path or host folder changed after validation",
        }
      }
      const botInit = options.entrypoint === "/usr/local/lib/touri/init.sh"
      const result = await command(
        [
          "create",
          "--name",
          options.name,
          "--label",
          "touri.vm=true",
          "--init",
          "--security-opt",
          "no-new-privileges",
          ...(botInit ? ["--cap-add", "NET_ADMIN"] : []),
          ...(engine === "podman" ? ["--network", "slirp4netns:allow_host_loopback=false"] : ["--network", "bridge"]),
          "--entrypoint",
          botInit ? "/usr/bin/python3" : (options.entrypoint ?? "/bin/sh"),
          ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
          ...(options.memoryMb === undefined ? [] : ["--memory", `${options.memoryMb}M`]),
          ...(options.cwd ? ["--workdir", options.cwd] : []),
          ...envArgs(options.env),
          ...volumes.flatMap((v) => [
            "--mount",
            `type=${v.type ?? "bind"},source=${v.source},target=${v.target}${v.readOnly ? ",readonly" : ""}`,
          ]),
          ...(options.dns ?? []).flatMap((d) => ["--dns", d]),
          options.image,
          ...(botInit ? ["-c", BOT_BOOT_COMMAND] : (options.args ?? ["-c", "while :; do sleep 3600; done"])),
        ],
        options.signal,
      )
      if (!result.success) return result
      const connection = await provider.connection({ id: options.name })
      if (!connection.success) return connection
      const { success, ...value } = connection
      return { success, ...ref(options.name), connection: value }
    },
    async start({ id, signal }) {
      const result = await command(["start", id], signal)
      if (!result.success) return result
      const connection = await provider.connection({ id })
      if (!connection.success) return connection
      const { success, ...value } = connection
      return { success, ...ref(id), connection: value }
    },
    async connection({ id, authKeyId }) {
      const ports = []
      for (const guestPort of [9876, 9222]) {
        const result = await forwarding.forwardPort({ id, guestPort })
        if (!result.success) return result
        ports.push(result)
      }
      if (authKeyId) keys.set(id, authKeyId)
      return { success: true, ...machineConnection({ id, provider: engine, ports, authKeyId: keys.get(id) ?? null }) }
    },
    async stop({ id }) {
      forwarding.forgetVm(id)
      const result = await command(["stop", "--time", "5", id])
      return result.success ? { success: true, ...ref(id) } : result
    },
    async destroy({ id }) {
      forwarding.forgetVm(id)
      keys.delete(id)
      const result = await command(["rm", "--force", id])
      return result.success ? { success: true, id } : result
    },
    async status({ id, signal }) {
      const result = await command(["ps", "--all", "--format", "{{json .}}", "--filter", `name=^${id}$`], signal)
      if (!result.success) return result
      try {
        const entries = result.output.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const value = JSON.parse(line)
            return Array.isArray(value) ? value : [value]
          }) as Array<{ Names?: string | string[]; State?: string; Status?: string }>
        const entry = entries.find((e) => (Array.isArray(e.Names) ? e.Names : [e.Names]).includes(id))
        const state = entry?.State?.toLowerCase() ?? entry?.Status?.toLowerCase() ?? ""
        return {
          success: true,
          id,
          status: !entry
            ? "missing"
            : /running|up/.test(state)
              ? "running"
              : /created|configured/.test(state)
                ? "created"
                : /exited|stopped/.test(state)
                  ? "stopped"
                  : "unknown",
        }
      } catch {
        return { success: false, errorCode: "STATUS_FAILED", error: "Invalid container status" }
      }
    },
    async inspect({ id, signal }) {
      const result = await command(["inspect", id], signal)
      if (!result.success) return result
      try {
        const entry = JSON.parse(result.output.stdout)[0] as {
          Config: { Image: string }
          HostConfig: { Memory?: number; Dns?: string[] }
          Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string; RW: boolean }>
        }
        if (!entry.Config.Image || !Array.isArray(entry.Mounts)) throw new Error()
        const volumes = entry.Mounts.map((m) => {
          if (!["volume", "bind"].includes(m.Type) || !m.Destination || !(m.Name || m.Source)) throw new Error()
          return {
            type: m.Type as "volume" | "bind",
            source: m.Type === "volume" ? (m.Name ?? m.Source) : m.Source,
            target: m.Destination,
            readOnly: !m.RW,
          }
        })
        return {
          success: true,
          image: entry.Config.Image,
          volumes,
          dns: entry.HostConfig.Dns ?? [],
          ...(entry.HostConfig.Memory ? { memoryMb: entry.HostConfig.Memory / 1024 ** 2 } : {}),
        }
      } catch {
        return { success: false, errorCode: "STATUS_FAILED", error: "Invalid container inspection; source preserved" }
      }
    },
    async exec(options) {
      if (!options.command.trim())
        return { success: false, errorCode: "INVALID_CONFIG", error: "VM command is required" }
      // A guest nonzero exit is a command result, not a transport failure.
      const result = await command([...execArgs(options), options.command, ...(options.args ?? [])], options.signal)
      return result.success ? { success: true, ...result.output } : result
    },
    spawn(options) {
      const marker = `/tmp/touri-${randomUUID()}.pid`
      const child = spawnTree({
        cmd: binary,
        cwd: tmpdir(),
        env: buildChildEnv(),
        args: [
          ...execArgs(options).slice(0, 1),
          "--interactive",
          ...execArgs(options).slice(1),
          "setsid",
          "--wait",
          "python3",
          "-c",
          VM_PROCESS_COMMAND,
          marker,
          options.command,
          ...(options.args ?? []),
        ],
      })
      if (!child.success) return child
      return {
        ...child,
        kill(signal) {
          child.kill(signal)
          void run([
            "exec",
            options.id,
            "node",
            "-e",
            CANCEL_VM_PROCESS_COMMAND,
            marker,
            signal,
            options.user ?? "0",
          ]).catch(() => {})
        },
      }
    },
    forwardPort: (input) => forwarding.forwardPort(input),
    async createVolume({ name, signal }) {
      if (!validName(name)) return { success: false, errorCode: "INVALID_NAME", error: "Invalid volume name" }
      const result = await command(["volume", "create", "--label", "touri.vm=true", name], signal)
      return result.success ? { success: true, name } : result
    },
    async deleteVolume({ name }) {
      if (!validName(name)) return { success: false, errorCode: "INVALID_NAME", error: "Invalid volume name" }
      const existing = await run(["volume", "inspect", name])
      if (existing.code !== 0 && /no such volume|not found/i.test(existing.stderr)) return { success: true, name }
      const result = await command(["volume", "rm", name])
      return result.success ? { success: true, name } : result
    },
    async snapshot({ id, path }) {
      if (!path.trim()) return { success: false, errorCode: "INVALID_CONFIG", error: "Snapshot path is required" }
      const result = await command(["export", "--output", path, id])
      return result.success ? { success: true, id, path } : result
    },
    async migrateWorkspace({ id, path, signal }) {
      // OCI export excludes mounted volumes. Keep existing named volumes untouched.
      const inspection = await provider.inspect({ id, ...(signal ? { signal } : {}) })
      if (!inspection.success) return inspection
      const workspace = inspection.volumes.find((v) => v.target === "/workspace")
      if (workspace) return { success: true, ...workspace }
      await mkdir(path, { recursive: true, mode: 0o700 })
      return {
        success: false,
        errorCode: "INVALID_CONFIG",
        error: "Legacy OCI rootfs migration requires an explicit backup; source preserved",
      }
    },
  }
  return provider
}
