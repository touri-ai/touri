import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join, posix } from "node:path"
import { platform } from "node:process"
import type {
  Bot,
  Kernel,
  ListeningPort,
  PreviewTarget,
  ProcessRunState,
  ProcessSpec,
  Project,
  ToolContext,
} from "@touri/contracts"
import { approvalDestination } from "../approvals/grants"
import { delegatedBot } from "../groups/security"
import { buildChildEnv } from "../kernel"
import { createBackgroundTask, getMeasuredStage, yieldBackground } from "../kernel/background-task"
import { atomicAppendFile, atomicWriteFile, ensurePrivateDirectory, removePrivateFile } from "../kernel/files"
import type { PerformanceStageRunner } from "../kernel/performance"
import { backoffDelay, debounce, sleep } from "../kernel/policy"
import { linuxRuntimeEnvironment } from "../platform/linux-environment"
import { projectSandboxCommand } from "../platform/project-sandbox"
import { surfaceUncertainEffects } from "../runtime/work-notice"
import { createWorkState, type WorkEffect, type WorkObservation, type WorkState } from "../runtime/work-state"
import { runCommand } from "./git"
import { processOwner, saveProcessOwner } from "./ownership"
import { processCwd } from "./paths"
import { resolveEnvSecret } from "./secrets"
import type { ManagedProcess, ProjectErrorCode, ProjectResult, ProjectStore, Supervisor, WorkScope } from "./types"

const now = (): number => Date.now()

const ACCESS_RANK: Record<Bot["access"], number> = { "read-only": 0, "workspace-write": 1, full: 2 }
const processPolicy = (value: Bot | null) =>
  JSON.stringify([
    value?.access,
    value?.approvals,
    value?.machine,
    value?.projectId,
    value?.folders,
    value?.anyFolderAccess,
  ])

const PROCESS_BOOT_AT: number = Date.now()

const errorResult = <T>(errorCode: ProjectErrorCode, error: string): ProjectResult<T> =>
  ({
    success: false,
    errorCode,
    error,
  }) as ProjectResult<T>

const isAlive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const readLines = async ({
  stream,
  onLine,
}: {
  stream: ReadableStream<Uint8Array>
  onLine: (line: string) => void
}): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) onLine(line)
    }
    pending += decoder.decode()
    if (pending.length > 0) onLine(pending)
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Bun can release a subprocess pipe's reader during process teardown.
    }
  }
}

const linePort = (line: string): number | null => {
  const match = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)/i)
  if (!match?.[1]) return null
  const port = Number(match[1])
  return port > 0 && port <= 65535 ? port : null
}

const portHost = (value: string): string => {
  const host = value.slice(0, value.lastIndexOf(":"))
  return host === "*" || host === "0.0.0.0" ? "127.0.0.1" : host.replace(/^\[|\]$/g, "")
}

const parseLsof = (text: string): Array<{ pid: number; host: string; port: number }> => {
  const results: Array<{ pid: number; host: string; port: number }> = []
  let pid: number | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const value = Number(line.slice(1))
      pid = Number.isFinite(value) ? value : null
      continue
    }
    if (!line.startsWith("n") || pid === null) continue
    const address = line.slice(1)
    const separator = address.lastIndexOf(":")
    if (separator < 0) continue
    const port = Number(address.slice(separator + 1))
    if (Number.isFinite(port) && port > 0 && port <= 65535) results.push({ pid, host: portHost(address), port })
  }
  return results
}

const parseProcessGroups = (text: string): Map<number, number> => {
  const groups = new Map<number, number>()
  for (const line of text.split(/\r?\n/)) {
    const [pidText, pgidText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const pgid = Number(pgidText)
    if (Number.isFinite(pid) && Number.isFinite(pgid)) groups.set(pid, pgid)
  }
  return groups
}

const pidStart = async ({ kernel, pid, cwd }: { kernel: Kernel; pid: number; cwd: string }): Promise<string | null> => {
  const result = await runCommand({ kernel, cmd: "ps", args: ["-o", "lstart=", "-p", String(pid)], cwd })
  if (!result.success || result.output.code !== 0) return null
  return result.output.stdout.trim() || null
}

const streamExists = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const rotateLogs = (root: string, directory: string): void => {
  if (!existsSync(directory)) return
  const files = readdirSync(directory)
    .map((name) => join(directory, name))
    .filter(streamExists)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  for (const file of files.slice(5)) {
    try {
      removePrivateFile({ root, path: file })
    } catch {}
  }
}

const wait = async (milliseconds: number, signal?: AbortSignal): Promise<boolean> => {
  try {
    await sleep(Math.max(0, milliseconds), signal)
    return !(signal?.aborted ?? false)
  } catch (error) {
    if (signal?.aborted) return false
    throw error
  }
}

export const createSupervisor = ({
  kernel,
  store,
  workState,
  recoverBefore,
  runStage,
}: {
  kernel: Kernel
  store: ProjectStore
  workState?: WorkState
  recoverBefore?: number
  runStage?: PerformanceStageRunner
}): Supervisor => {
  const work: WorkState = workState ?? createWorkState({ database: kernel.db as Database })
  const managed = new Map<string, ManagedProcess>()
  const processPolicies = new Map<string, { botId: string; policy: string; child: ManagedProcess["child"] }>()
  const stopRequested = new Set<string>()
  const failureHistory = new Map<string, Array<number>>()
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const portTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pendingLogs = new Map<string, Array<string>>()
  const logTimers = new Map<string, ReturnType<typeof debounce>>()
  let shuttingDown = false

  const publish = (processId: string): void => {
    const spec = store.getProcessSpec({ processId })
    if (!spec) return
    kernel.publish({
      type: "process.updated",
      spec,
      run: store.getCurrentProcessRun({ processId }) ?? store.getLatestProcessRun({ processId }),
    })
  }

  const flushLogs = (processId: string): void => {
    const lines = pendingLogs.get(processId) ?? []
    pendingLogs.delete(processId)
    const timer = logTimers.get(processId)
    timer?.cancel()
    logTimers.delete(processId)
    if (lines.length > 0) kernel.publish({ type: "process.log", processId, lines })
  }

  const clearProcessTimers = (processId: string): void => {
    const portTimer = portTimers.get(processId)
    if (portTimer !== undefined) clearInterval(portTimer)
    portTimers.delete(processId)
    flushLogs(processId)
  }

  const resolveEnv = async ({
    project,
    spec,
    ctx,
  }: {
    project: Project
    spec: ProcessSpec
    ctx?: ToolContext
  }): Promise<ProjectResult<{ env: Record<string, string>; guards: Array<() => boolean> }>> => {
    const guards: Array<() => boolean> = []
    const environment = spec.vmBotId ? ({} as Record<string, string>) : await kernel.shellEnv()
    for (const [name, value] of Object.entries(spec.env)) {
      if (typeof value === "string") {
        environment[name] = value
        if (value.length >= 6) kernel.addRedactionValue(value)
        continue
      }
      const secret = store.getSecret({ projectId: project.id, name: value.secret })
      if (!secret?.usage.env) return errorResult("DENIED", "A credencial não permite exportação para o ambiente.")
      const botId = spec.vmBotId ?? processOwner(kernel, spec.id)?.botId
      const bot = botId ? kernel.services.use("store.api")?.getBot({ botId }) : null
      const context =
        ctx ??
        (bot
          ? {
              botId: bot.id,
              threadId: bot.mainThreadId ?? "",
              runId: null,
              projectId: project.id,
              cwd: spec.cwd,
              signal: new AbortController().signal,
            }
          : null)
      if (!context) return errorResult("DENIED", "A exportação requer um bot responsável pelo processo.")
      const configuration = JSON.stringify(spec)
      const result = await resolveEnvSecret({
        kernel,
        store,
        ctx: context,
        projectId: project.id,
        name: value.secret,
        destination: JSON.stringify({
          project: project.id,
          process: spec.id,
          cwd: spec.cwd,
          variable: name,
          configuration: createHash("sha256").update(configuration).digest("hex"),
        }),
        destinationLabel: `Processo ${spec.name}, variável ${name}, pasta ${spec.cwd}`,
        isCurrent: () => JSON.stringify(store.getProcessSpec({ processId: spec.id })) === configuration,
      })
      if (!result.success) return errorResult(result.errorCode, result.error)
      guards.push(result.isCurrent)
      environment[name] = result.value
    }
    return { success: true, env: spec.vmBotId ? environment : buildChildEnv({ base: environment }), guards }
  }

  const detectPorts = async ({
    project,
    process,
  }: {
    project: Project
    process: ManagedProcess
  }): Promise<Array<ListeningPort>> => {
    if (shuttingDown) return process.ports
    if (process.spec.vmBotId) {
      const vm = kernel.services.use("vm.runtime")
      if (!vm) return []
      const [listeners, groupsResult] = await Promise.all([
        vm.exec({ botId: process.spec.vmBotId, command: "ss", args: ["-ltnpH"] }),
        vm.exec({ botId: process.spec.vmBotId, command: "ps", args: ["-A", "-o", "pid=,pgid="] }),
      ])
      if (!listeners.success || !groupsResult.success) return process.ports
      const groups = parseProcessGroups(groupsResult.stdout)
      const found = listeners.stdout.split("\n").flatMap((line) => {
        const fields = line.trim().split(/\s+/)
        const port = Number(fields[3]?.split(":").at(-1))
        const pids = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))
        const owned = pids.some((pid) => pid === process.guestPgid || groups.get(pid) === process.guestPgid)
        return owned && port > 0
          ? [{ port, host: "127.0.0.1", pid: process.run.pid ?? 0, detectedAt: now(), via: "log" as const }]
          : []
      })
      process.ports = [...new Map([...process.ports, ...found].map((port) => [port.port, port])).values()]
      store.updateProcessRun({ runId: process.run.id, ports: process.ports })
      return process.ports
    }
    const [lsof, ps] = await Promise.all([
      runCommand({ kernel, cmd: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], cwd: project.path }),
      runCommand({ kernel, cmd: "ps", args: ["-A", "-o", "pid=,pgid="], cwd: project.path }),
    ])
    if (shuttingDown) return process.ports
    if (!lsof.success || !ps.success) return process.ports
    const groups = parseProcessGroups(ps.output.stdout)
    const ports = parseLsof(lsof.output.stdout)
      .filter((port) => port.pid === process.run.pid || groups.get(port.pid) === process.run.pgid)
      .map((port) => ({ port: port.port, host: port.host, pid: port.pid, detectedAt: now(), via: "lsof" as const }))
    const logged = process.ports.filter((port) => port.via === "log")
    const unique = new Map<number, ListeningPort>()
    for (const port of [...logged, ...ports]) unique.set(port.port, port)
    process.ports = [...unique.values()].sort((left, right) => left.port - right.port)
    store.updateProcessRun({ runId: process.run.id, ports: process.ports })
    return process.ports
  }

  const emitPreview = async ({
    project,
    process,
    port,
  }: {
    project: Project
    process: ManagedProcess
    port: number
  }): Promise<void> => {
    if (process.previewPorts.has(port)) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1000)
    try {
      const forwarded = process.spec.vmBotId
        ? await kernel.services.use("vm.runtime")?.forwardPort({ botId: process.spec.vmBotId, guestPort: port })
        : null
      const hostPort = forwarded?.hostPort ?? port
      const base = forwarded ? forwarded.url.replace(/\/$/, "") : `http://127.0.0.1:${hostPort}`
      process.hostPorts ??= new Map()
      process.hostPorts.set(port, hostPort)
      process.previewBases ??= new Map()
      process.previewBases.set(port, base)
      if (process.spec.vmBotId && !forwarded) return
      const response = await fetch(`${base}/`, { signal: controller.signal, redirect: "manual" })
      if (response.status >= 100 && response.status <= 599) {
        process.previewPorts.add(port)
        kernel.publish({
          type: "preview.available",
          preview: {
            vmBotId: process.spec.vmBotId ?? null,
            projectId: project.id,
            processId: process.spec.id,
            url: `${base}/`,
            port: hostPort,
            label: process.spec.name,
          },
        })
      }
    } catch {
      // A listening database or cache port is not a preview target.
    } finally {
      clearTimeout(timer)
    }
  }

  const logLine = ({ project, process, line }: { project: Project; process: ManagedProcess; line: string }): void => {
    if (shuttingDown) return
    const safe = kernel.redact(line)
    if (safe.length === 0) return
    process.logLines.push(safe)
    if (process.logLines.length > 2000) process.logLines.splice(0, process.logLines.length - 2000)
    atomicAppendFile({
      root: kernel.paths.appData,
      path: process.logPath,
      content: `${safe}\n`,
      maxBytes: 10 * 1024 * 1024,
    })
    const batch = pendingLogs.get(process.spec.id) ?? []
    batch.push(safe)
    pendingLogs.set(process.spec.id, batch)
    if (!logTimers.has(process.spec.id)) {
      const delivery = debounce({ callback: () => flushLogs(process.spec.id), waitMs: 200 })
      logTimers.set(process.spec.id, delivery)
      delivery.call()
    }
    const fromLog = linePort(safe)
    if (fromLog !== null && !process.ports.some((port) => port.port === fromLog)) {
      process.ports.push({ port: fromLog, host: "127.0.0.1", pid: process.run.pid ?? 0, detectedAt: now(), via: "log" })
      store.updateProcessRun({ runId: process.run.id, ports: process.ports })
      void emitPreview({ project, process, port: fromLog })
    }
    if (process.spec.ready && "logRegex" in process.spec.ready) {
      try {
        if (new RegExp(process.spec.ready.logRegex).test(safe)) process.ready = true
      } catch {
        // Invalid regular expressions are rejected by the route/tool validation layer in normal use.
      }
    }
    if (process.spec.previewPort !== null && safe.includes(String(process.spec.previewPort)))
      void emitPreview({ project, process, port: process.spec.previewPort })
  }

  const recordWorkResult = ({
    process,
    status,
    exitCode,
  }: {
    process: ManagedProcess
    status: "exited" | "crashed" | "stopped"
    exitCode: number | null
  }): void => {
    if (!process.effect) return
    work.recordResult({ effectId: process.effect.id, turnId: process.effect.turnId, status, exitCode })
  }

  const monitor = ({ project, process }: { project: Project; process: ManagedProcess }): void => {
    void Promise.all([
      readLines({ stream: process.child.stdout, onLine: (line) => logLine({ project, process, line }) }),
      readLines({ stream: process.child.stderr, onLine: (line) => logLine({ project, process, line }) }),
    ])
    void process.child.exited.then(async (exit) => {
      if (managed.get(process.spec.id)?.run.id !== process.run.id) return
      managed.delete(process.spec.id)
      processPolicies.delete(process.spec.id)
      clearProcessTimers(process.spec.id)
      const ended = now()
      const machineStopped =
        process.spec.vmBotId &&
        kernel.services
          .use("vm.runtime")
          ?.states()
          .find((state) => state.botId === process.spec.vmBotId)?.status !== "running"
      if (process.stopped || stopRequested.has(process.spec.id) || shuttingDown || machineStopped) {
        stopRequested.delete(process.spec.id)
        recordWorkResult({ process, status: "stopped", exitCode: exit.code })
        store.updateProcessRun({
          runId: process.run.id,
          status: "stopped",
          exitCode: exit.code,
          signal: exit.signal,
          endedAt: ended,
        })
        publish(process.spec.id)
        return
      }
      const failed = exit.code !== 0 || exit.signal !== null
      const status = failed ? "crashed" : "exited"
      recordWorkResult({ process, status, exitCode: exit.code })
      store.updateProcessRun({
        runId: process.run.id,
        status,
        exitCode: exit.code,
        signal: exit.signal,
        endedAt: ended,
      })
      publish(process.spec.id)
      if (!failed || process.spec.restart === "never") return
      const history = (failureHistory.get(process.spec.id) ?? []).filter((at) => at >= ended - 10 * 60 * 1000)
      history.push(ended)
      failureHistory.set(process.spec.id, history)
      if (history.length >= 5) {
        store.updateProcessRun({ runId: process.run.id, status: "crashed", endedAt: ended })
        kernel.services.use("notify.emit")?.({
          kind: "incident",
          botId: null,
          threadId: null,
          title: `${process.spec.name} crashed`,
          body: "The process failed five times in ten minutes.",
        })
        publish(process.spec.id)
        return
      }
      const configuredBase = Number(globalThis.process.env.TOURI_TEST_PROCESS_BACKOFF_MS ?? "1000")
      const baseDelay = Number.isFinite(configuredBase) && configuredBase > 0 ? configuredBase : 1000
      const delay = backoffDelay({ attempt: history.length, initialMs: baseDelay, maxMs: 60_000 })
      const restartTimer = setTimeout(() => {
        restartTimers.delete(process.spec.id)
        const measure = getMeasuredStage("project_supervisor_restart", runStage)
        const current = measure(() => store.getProcessSpec({ processId: process.spec.id }))
        if (!current || shuttingDown) return
        void measure(() =>
          start({
            project,
            spec: current,
            waitMs: 0,
            scope: { turnId: process.effect?.turnId ?? null, threadId: null, automatic: true },
            ...(process.confine ? { confine: process.confine } : {}),
          }),
        )
      }, delay)
      restartTimers.set(process.spec.id, restartTimer)
    })
  }

  const checkReady = async ({ process }: { process: ManagedProcess }): Promise<boolean> => {
    const ready = process.spec.ready
    if (ready === null) return process.ready
    if ("port" in ready) return process.ports.some((port) => port.port === ready.port)
    if ("http" in ready && process.spec.vmBotId) {
      const result = await kernel.services
        .use("vm.runtime")
        ?.exec({ botId: process.spec.vmBotId, command: "curl", args: ["-fsS", "--max-time", "1", ready.http] })
      return result?.success === true
    }
    if ("http" in ready) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1000)
      try {
        const response = await fetch(ready.http, { signal: controller.signal })
        process.ready = response.status >= 100 && response.status <= 599
      } catch {
        process.ready = false
      } finally {
        clearTimeout(timer)
      }
      return process.ready
    }
    return process.ready
  }

  const waitReady = async ({
    project,
    process,
    waitMs,
    signal,
  }: {
    project: Project
    process: ManagedProcess
    waitMs: number
    signal?: AbortSignal
  }): Promise<boolean> => {
    const deadline = now() + waitMs
    const noCheckReadyAt = now() + 2000
    while (now() <= deadline && isAlive(process.run.pid)) {
      if (signal?.aborted) return false
      await detectPorts({ project, process })
      for (const port of process.ports) void emitPreview({ project, process, port: port.port })
      if (await checkReady({ process })) {
        process.ready = true
        store.updateProcessRun({ runId: process.run.id, status: "ready", ports: process.ports })
        publish(process.spec.id)
        return true
      }
      if (process.spec.ready === null && now() >= noCheckReadyAt) {
        process.ready = true
        store.updateProcessRun({ runId: process.run.id, status: "ready", ports: process.ports })
        publish(process.spec.id)
        return true
      }
      await wait(250, signal)
    }
    return false
  }

  const dependencyOrder = ({
    projectId,
    root,
  }: {
    projectId: string
    root: ProcessSpec
  }): ProjectResult<{ order: Array<ProcessSpec> }> => {
    const specs = new Map(
      store
        .listProcessSpecs({ projectId })
        .filter((spec) => (spec.vmBotId ?? null) === (root.vmBotId ?? null))
        .map((spec) => [spec.name, spec]),
    )
    specs.set(root.name, root)
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const order: Array<ProcessSpec> = []
    const visit = (name: string): ProjectResult<Record<never, never>> => {
      if (visited.has(name)) return { success: true }
      if (visiting.has(name)) return errorResult("PROCESS_CYCLE", `Process dependency cycle includes ${name}`)
      const spec = specs.get(name)
      if (!spec) return errorResult("PROCESS_DEPENDENCY", `Unknown process dependency ${name}`)
      visiting.add(name)
      for (const dependency of spec.dependsOn) {
        const result = visit(dependency)
        if (!result.success) return result
      }
      visiting.delete(name)
      visited.add(name)
      order.push(spec)
      return { success: true }
    }
    const result = visit(root.name)
    return result.success ? { success: true, order } : result
  }

  const effectiveOwner = ({
    botId,
    threadId,
    confine,
  }: {
    botId: string | null | undefined
    threadId?: string | undefined
    confine?: Bot["access"] | undefined
  }): Bot | null => {
    const stored = botId ? kernel.services.use("store.api")?.getBot({ botId }) : null
    if (!stored) return null
    const delegated = threadId ? delegatedBot(kernel, threadId, stored) : stored
    if (!confine || ACCESS_RANK[confine] >= ACCESS_RANK[delegated.access]) return delegated
    return { ...delegated, access: confine }
  }

  const define = ({
    botId,
    vmBotId,
    project,
    name,
    command,
    cwd,
    env,
    autostart,
    restart,
    dependsOn,
    ready,
    previewPort,
    createdBy,
    threadId,
  }: Parameters<Supervisor["define"]>[0]): ProjectResult<{ spec: ProcessSpec }> => {
    const existing = store.getProcessSpecByName({ projectId: project.id, name, vmBotId: vmBotId ?? null })
    if (
      botId &&
      existing &&
      processOwner(kernel, existing.id)?.botId !== botId &&
      existing.vmBotId !== botId &&
      !(existing.createdBy === "user" && !processOwner(kernel, existing.id))
    )
      return errorResult("DENIED", "Este processo pertence a outro responsável.")
    const owner = effectiveOwner({ botId, threadId })
    const reduced =
      !!owner && owner.access !== (botId ? kernel.services.use("store.api")?.getBot({ botId })?.access : undefined)
    if (
      botId &&
      (!owner ||
        owner.access === "read-only" ||
        owner.projectId !== project.id ||
        (owner.machine !== "local" && vmBotId !== botId))
    )
      return errorResult("DENIED", "A política do bot não permite definir este processo.")
    const guestCwd = posix.resolve("/workspace", cwd)
    if (vmBotId && guestCwd !== "/workspace" && !guestCwd.startsWith("/workspace/"))
      return errorResult("PATH_OUTSIDE_PROJECT", "Cwd fora de /workspace")
    const cwdResult = vmBotId ? { success: true as const, path: guestCwd } : processCwd({ project, cwd })
    if (!cwdResult.success) return cwdResult
    if (vmBotId) {
      const bot = kernel.services.use("store.api")?.getBot({ botId: vmBotId })
      if (bot?.machine !== "vm" || bot.projectId !== project.id)
        return errorResult("INVALID_ARGS", "Bot não pertence à VM deste projeto")
    }
    const candidate: ProcessSpec = {
      vmBotId: vmBotId ?? null,
      id: store.getProcessSpecByName({ projectId: project.id, name, vmBotId: vmBotId ?? null })?.id ?? kernel.newId(),
      projectId: project.id,
      name,
      command,
      cwd: cwdResult.path,
      env,
      autostart,
      restart,
      dependsOn,
      ready,
      previewPort,
      createdBy,
      createdAt: now(),
      updatedAt: now(),
    }
    const order = dependencyOrder({ projectId: project.id, root: candidate })
    if (!order.success) return order
    const result = store.upsertProcess({
      vmBotId: vmBotId ?? null,
      projectId: project.id,
      name,
      command,
      cwd: cwdResult.path,
      env,
      autostart: autostart && !reduced,
      restart,
      dependsOn,
      ready,
      previewPort,
      createdBy,
      now: now(),
    })
    if (result.success && owner) saveProcessOwner(kernel, result.spec.id, { botId: owner.id, machine: owner.machine })
    return result
  }

  const startOne = async ({
    project,
    spec,
    waitMs,
    signal,
    scope,
    ctx,
    confine,
  }: {
    project: Project
    spec: ProcessSpec
    waitMs: number
    signal?: AbortSignal
    scope?: WorkScope
    ctx?: ToolContext
    confine?: Bot["access"]
  }): Promise<ProjectResult<{ run: ProcessRunState }>> => {
    const ownership = processOwner(kernel, spec.id)
    const botId = spec.vmBotId ?? ownership?.botId
    if (!botId && spec.createdBy === "agent")
      return errorResult("DENIED", "Redefina este processo para confirmar o bot responsável antes de executá-lo.")
    const effective = (): Bot | null => effectiveOwner({ botId, threadId: ctx?.threadId, confine })
    const bot = effective()
    if (
      botId &&
      (!bot ||
        bot.access === "read-only" ||
        bot.projectId !== project.id ||
        (ownership && ownership.machine !== bot.machine) ||
        (bot.machine !== "local" && spec.vmBotId !== botId))
    )
      return errorResult("DENIED", "A política do bot não permite iniciar este processo.")
    if (ctx && botId !== ctx.botId) return errorResult("DENIED", "Este processo pertence a outro responsável.")
    const policy = processPolicy(bot)
    const destination = botId ? approvalDestination(kernel, botId) : null
    const authorizationCurrent = () => {
      const latest = effective()
      return (
        !signal?.aborted &&
        !ctx?.signal.aborted &&
        processPolicy(latest) === policy &&
        (!botId || approvalDestination(kernel, botId) === destination) &&
        JSON.stringify(store.getProcessSpec({ processId: spec.id })) === JSON.stringify(spec)
      )
    }
    if (spec.vmBotId) {
      const bot = kernel.services.use("store.api")?.getBot({ botId: spec.vmBotId })
      if (bot?.machine !== "vm" || bot.projectId !== project.id)
        return errorResult("PROCESS_START_FAILED", "Processo não pertence ao projeto atual da VM")
    }
    const existing = managed.get(spec.id)
    if (existing && isAlive(existing.run.pid)) return { success: true, run: existing.run }
    const environment = await resolveEnv({ project, spec, ...(ctx ? { ctx } : {}) })
    if (!environment.success) return environment
    const command = spec.command.replaceAll("<dataDir>", project.dataDir)
    const shell = environment.env.SHELL ?? "/bin/sh"
    const quotedCommand = command.replaceAll("'", "'\\''")
    const vm = spec.vmBotId ? kernel.services.use("vm.runtime") : null
    if (spec.vmBotId && !vm) return errorResult("PROCESS_START_FAILED", "VM indisponível")
    let release: (() => Promise<void>) | undefined
    if (vm && spec.vmBotId) {
      try {
        release = await vm.acquire({ botId: spec.vmBotId })
      } catch (error) {
        return errorResult("PROCESS_START_FAILED", String(error))
      }
    }
    if (!authorizationCurrent() || environment.guards.some((guard) => !guard())) {
      await release?.()
      return errorResult("DENIED", "A autorização mudou antes da execução.")
    }
    let localSpawn: Parameters<Kernel["spawnTree"]>[0] = {
      cmd: shell,
      args: ["-c", `exec ${shell} -c '${quotedCommand}'`],
      cwd: spec.cwd,
      env: environment.env,
    }
    // Full access has no folder restriction; other Linux bots with grants keep their boundary.
    const linuxGrants =
      platform === "linux" && bot?.access !== "full" && !!(bot?.folders?.length || bot?.anyFolderAccess)
    if (!vm && bot && (bot.access === "workspace-write" || linuxGrants)) {
      const temporary = join(project.dataDir, "tmp", spec.id)
      ensurePrivateDirectory({ root: kernel.paths.appData, path: temporary })
      // The launcher runs before confinement. Loader hooks and project PATH
      // must not replace it or inject code into that initial host process.
      localSpawn.env = Object.fromEntries(
        Object.entries({ ...environment.env, TMPDIR: temporary }).filter(([name]) => !/^(?:LD_|DYLD_)/i.test(name)),
      )
      if (platform === "linux")
        localSpawn.env = { ...linuxRuntimeEnvironment(environment.env, Object.keys(spec.env)), TMPDIR: temporary }
      const roots = [project.path, bot.homeDir, project.dataDir, temporary]
      const sandbox = projectSandboxCommand({
        roots,
        shell,
        command,
        folders: bot.folders ?? [],
        appData: kernel.paths.appData,
        env: environment.env,
      })
      if (!sandbox)
        return errorResult("DENIED", "O sandbox local está indisponível. Execute este processo na máquina do bot.")
      localSpawn = { ...localSpawn, ...sandbox }
    }
    const guestPidFile = `/workspace/.touri/run/process-${spec.id}.pid`
    const effectId = kernel.newId()
    const turnId = scope?.turnId ?? null
    const intent = work.beginEffect({
      turnId,
      threadId: scope?.threadId ?? null,
      key: spec.id,
      description: spec.name,
      effectId,
    })
    if (!intent.success || !intent.fresh) {
      await release?.()
      return errorResult("PROCESS_START_FAILED", "Não foi possível registrar a intenção de iniciar o processo")
    }
    const child =
      vm && spec.vmBotId
        ? vm.spawn({
            botId: spec.vmBotId,
            cmd: "/bin/sh",
            args: [
              "-c",
              'echo $$ > "$1"; exec /bin/sh -c "$2"',
              "touri",
              guestPidFile,
              command.replaceAll(project.dataDir, "/workspace/.touri/data"),
            ],
            cwd: spec.cwd,
            env: environment.env,
          })
        : kernel.spawnTree(localSpawn)
    if (child.success && botId)
      processPolicies.set(spec.id, {
        botId,
        child,
        policy: processPolicy(kernel.services.use("store.api")?.getBot({ botId }) ?? null),
      })
    await release?.()
    if (!child.success) {
      work.recordResult({ effectId, turnId, status: "failed", exitCode: null })
      return errorResult("PROCESS_START_FAILED", child.error)
    }
    work.recordIdentity({ effectId, turnId, pid: child.pid, pgid: child.pgid })
    const logDirectory = join(project.dataDir, "logs", spec.name)
    ensurePrivateDirectory({ root: kernel.paths.appData, path: logDirectory })
    const runId = kernel.newId()
    const logPath = join(logDirectory, `${runId}.log`)
    atomicWriteFile({ root: kernel.paths.appData, path: logPath, content: "" })
    rotateLogs(kernel.paths.appData, logDirectory)
    const startedAt = now()
    const startPid = await pidStart({ kernel, pid: child.pid, cwd: project.path })
    const run: ProcessRunState = store.insertProcessRun({
      id: runId,
      processId: spec.id,
      pid: child.pid,
      pgid: child.pgid,
      pidStart: startPid,
      status: "running",
      logPath,
      startedAt,
    })
    work.recordIdentity({ effectId, turnId, processRunId: run.id, pidStart: startPid })
    const process: ManagedProcess = {
      spec,
      run,
      effect: { id: effectId, turnId },
      failures: failureHistory.get(spec.id) ?? [],
      stopped: false,
      ports: [],
      logLines: [],
      logPath,
      child,
      previewPorts: new Set(),
      ready: false,
      ...(bot && botId && bot.access !== kernel.services.use("store.api")?.getBot({ botId })?.access
        ? { confine: bot.access }
        : {}),
    }
    if (vm && spec.vmBotId) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const group = await vm.exec({ botId: spec.vmBotId, command: "cat", args: [guestPidFile] })
        if (group.success) {
          process.guestPgid = Number(group.stdout.trim())
          break
        }
        await wait(50)
      }
    }
    managed.set(spec.id, process)
    monitor({ project, process })
    if (!authorizationCurrent() || stopRequested.has(spec.id)) {
      stopRequested.add(spec.id)
      process.stopped = true
      child.kill("SIGKILL")
      await child.exited
      return errorResult("DENIED", "A autorização mudou antes da execução.")
    }
    const portTask = createBackgroundTask(
      "project_supervisor_ports",
      async () => {
        const ports = await detectPorts({ project, process })
        for (const port of ports) {
          if (shuttingDown || process.stopped) return

          await yieldBackground()
          await emitPreview({ project, process, port: port.port })
        }
      },
      runStage,
    )
    portTimers.set(
      spec.id,
      setInterval(() => {
        void portTask.run().catch(() => undefined)
      }, 2000),
    )
    publish(spec.id)
    const ready =
      signal === undefined
        ? await waitReady({ project, process, waitMs })
        : await waitReady({ project, process, waitMs, signal })
    const current = store.getProcessRun({ runId })
    if (!ready)
      return errorResult(
        "PROCESS_NOT_READY",
        current ? `Process ${spec.name} did not become ready` : `Process ${spec.name} exited`,
      )
    return { success: true, run: current ?? run }
  }

  const start = async ({
    project,
    spec,
    waitMs,
    signal,
    scope: explicitScope,
    ctx,
    confine,
  }: Parameters<Supervisor["start"]>[0]): Promise<ProjectResult<{ run: ProcessRunState }>> => {
    const scope: WorkScope | undefined =
      explicitScope ?? (ctx ? { turnId: ctx.runId, threadId: ctx.threadId, automatic: true } : undefined)
    if (scope?.automatic && work.isBlocked({ key: spec.id }))
      return errorResult(
        "PROCESS_START_FAILED",
        `Não foi possível confirmar se o processo ${spec.name} terminou; verifique antes de repetir.`,
      )
    if (!scope?.automatic) work.acknowledgeKey({ key: spec.id })
    const order = dependencyOrder({ projectId: project.id, root: spec })
    if (!order.success) return order
    let last: ProcessRunState | null = null
    for (const dependency of order.order) {
      const result = await startOne({
        project,
        spec: dependency,
        waitMs,
        ...(signal ? { signal } : {}),
        ...(ctx ? { ctx } : {}),
        ...(scope ? { scope } : {}),
        ...(confine ? { confine } : {}),
      })
      if (!result.success) return result
      last = result.run
    }
    return last === null
      ? errorResult("PROCESS_START_FAILED", `Process ${spec.name} could not start`)
      : { success: true, run: last }
  }

  const stop = async ({ processId }: { processId: string }): Promise<ProjectResult<{ run: ProcessRunState }>> => {
    const process = managed.get(processId)
    const current = store.getCurrentProcessRun({ processId })
    if (!process || !current) {
      const spec = store.getProcessSpec({ processId })
      if (!spec) return errorResult("PROCESS_NOT_FOUND", `Process ${processId} was not found`)
      return {
        success: true,
        run: store.getLatestProcessRun({ processId }) ?? {
          id: "",
          processId,
          pid: null,
          pgid: null,
          status: "stopped",
          exitCode: null,
          signal: null,
          ports: [],
          logPath: "",
          startedAt: 0,
          endedAt: now(),
        },
      }
    }
    stopRequested.add(processId)
    process.stopped = true
    process.child.kill("SIGTERM")
    const graceful = await Promise.race([process.child.exited.then(() => true), wait(5000).then(() => false)])
    if (!graceful) process.child.kill("SIGKILL")
    await process.child.exited
    const run = store.getProcessRun({ runId: current.id })
    return run === null ? errorResult("PROCESS_NOT_FOUND", "Process run disappeared") : { success: true, run }
  }

  const restart = async ({
    project,
    spec,
    waitMs,
    scope,
    ctx,
    signal,
    confine,
  }: Parameters<Supervisor["restart"]>[0]): Promise<ProjectResult<{ run: ProcessRunState }>> => {
    const current = store.getCurrentProcessRun({ processId: spec.id })
    if (current) {
      const stopped = await stop({ processId: spec.id })
      if (!stopped.success) return stopped
    }
    return start({
      project,
      spec,
      waitMs,
      ...(ctx ? { ctx } : {}),
      ...(signal ? { signal } : {}),
      ...(scope ? { scope } : {}),
      ...(confine ? { confine } : {}),
    })
  }

  const list = ({ projectId }: { projectId: string }): Array<{ spec: ProcessSpec; run: ProcessRunState | null }> =>
    store.listProcessSpecs({ projectId }).map((spec) => ({
      spec,
      run: store.getCurrentProcessRun({ processId: spec.id }) ?? store.getLatestProcessRun({ processId: spec.id }),
    }))

  const logs = ({
    processId,
    tail,
    grep,
  }: {
    processId: string
    tail: number
    grep?: string
  }): ProjectResult<{ lines: Array<string> }> => {
    const spec = store.getProcessSpec({ processId })
    if (!spec) return errorResult("PROCESS_NOT_FOUND", `Process ${processId} was not found`)
    const run = store.getCurrentProcessRun({ processId }) ?? store.getLatestProcessRun({ processId })
    const lines = run ? store.getProcessLogs({ runId: run.id, tail }) : []
    return { success: true, lines: grep ? lines.filter((line) => line.includes(grep)) : lines }
  }

  const previews = ({ projectId }: { projectId?: string } = {}): Array<PreviewTarget> => {
    const result: Array<PreviewTarget> = []
    for (const process of managed.values()) {
      if (projectId !== undefined && process.spec.projectId !== projectId) continue
      for (const port of process.ports) {
        if (!process.previewPorts.has(port.port)) continue
        result.push({
          vmBotId: process.spec.vmBotId ?? null,
          projectId: process.spec.projectId,
          processId: process.spec.id,
          url: `${process.previewBases?.get(port.port) ?? `http://127.0.0.1:${port.port}`}/`,
          port: process.hostPorts?.get(port.port) ?? port.port,
          label: process.spec.name,
        })
      }
    }
    return result
  }

  const openPreview = ({
    botId,
    project,
    port,
    processName,
    path,
    vmBotId,
  }: Parameters<Supervisor["openPreview"]>[0]): ProjectResult<{ preview: PreviewTarget }> => {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path))
      return errorResult("INVALID_ARGS", "Preview path must be local and start with /")
    const candidates = [...managed.values()].filter(
      (process) =>
        process.spec.projectId === project.id &&
        (processName === undefined || process.spec.name === processName) &&
        (vmBotId === undefined || (process.spec.vmBotId ?? null) === vmBotId) &&
        (botId === undefined || (process.spec.vmBotId ?? processOwner(kernel, process.spec.id)?.botId) === botId),
    )
    const candidate =
      port === undefined
        ? candidates.find((process) => process.ports.some((item) => process.previewPorts.has(item.port)))
        : candidates.find((process) =>
            process.ports.some(
              (item) =>
                process.previewPorts.has(item.port) &&
                (item.port === port || process.hostPorts?.get(item.port) === port),
            ),
          )
    const selectedPort = candidate?.ports.find(
      (item) =>
        candidate.previewPorts.has(item.port) &&
        (port === undefined || item.port === port || candidate.hostPorts?.get(item.port) === port),
    )?.port
    if (!candidate || selectedPort === undefined)
      return errorResult(
        "PREVIEW_NOT_FOUND",
        "Nenhum Preview foi criado. Use process_define/process_start para iniciar um processo HTTP deste bot no projeto vinculado, aguarde a porta HTTP ficar disponível e tente preview_open novamente. Servidores iniciados pelo terminal e processos de outros bots não podem ser usados.",
      )
    const hostPort = candidate.hostPorts?.get(selectedPort) ?? selectedPort
    const preview: PreviewTarget = {
      vmBotId: candidate.spec.vmBotId ?? null,
      projectId: project.id,
      processId: candidate.spec.id,
      url: `${candidate.previewBases?.get(selectedPort) ?? `http://127.0.0.1:${hostPort}`}${path}`,
      port: hostPort,
      label: candidate.spec.name,
    }
    kernel.publish({ type: "preview.available", preview })
    return { success: true, preview }
  }

  const stopGroup = async ({ pgid, cwd }: { pgid: number; cwd: string }): Promise<void> => {
    if (pgid <= 0) return
    await runCommand({ kernel, cmd: "kill", args: ["-TERM", "--", `-${pgid}`], cwd })
    await wait(100)
    let groupAlive = false
    try {
      process.kill(-pgid, 0)
      groupAlive = true
    } catch {
      groupAlive = false
    }
    if (groupAlive) await runCommand({ kernel, cmd: "kill", args: ["-KILL", "--", `-${pgid}`], cwd })
  }

  const cleanupOrphans = async (): Promise<void> => {
    for (const item of store.getLiveProcessRuns()) {
      const alive = isAlive(item.run.pid)
      const currentStart =
        item.run.pid === null ? null : await pidStart({ kernel, pid: item.run.pid, cwd: kernel.paths.appData })
      if (alive && item.run.pgid !== null && (item.pidStart === null || currentStart === item.pidStart)) {
        await stopGroup({ pgid: item.run.pgid, cwd: kernel.paths.appData })
      }
      store.updateProcessRun({ runId: item.run.id, status: "stopped", endedAt: now() })
      publish(item.run.processId)
    }
    recoverWork()
  }

  const observeEffect = (effect: WorkEffect): WorkObservation => {
    const run = effect.processRunId === null ? null : store.getProcessRun({ runId: effect.processRunId })
    if (run && (run.status === "exited" || run.status === "crashed" || run.status === "stopped"))
      return { kind: "finished", status: run.status, exitCode: run.exitCode }
    return {
      kind: "unobservable",
      reason: effect.pid === null ? "spawn not confirmed before restart" : "exit not observed before restart",
    }
  }

  const recoverWork = (): void => {
    const recovered = work.recover({ observe: observeEffect, before: recoverBefore ?? PROCESS_BOOT_AT })
    if (recovered.uncertain.length > 0) surfaceUncertainEffects({ kernel, effects: recovered.uncertain })
  }

  const autostart = async (): Promise<void> => {
    const specs = store
      .listProjects()
      .flatMap((project) => store.listProcessSpecs({ projectId: project.id }).map((spec) => ({ project, spec })))
      .filter(
        ({ spec }) =>
          spec.autostart &&
          (!spec.vmBotId ||
            kernel.services
              .use("vm.runtime")
              ?.states()
              .some((state) => state.botId === spec.vmBotId && state.status === "running")),
      )
    for (const item of specs) {
      if (shuttingDown) return
      await start({
        project: item.project,
        spec: item.spec,
        waitMs: 20_000,
        scope: { turnId: null, threadId: null, automatic: true },
      })
    }
  }

  const stopAll = async (): Promise<void> => {
    shuttingDown = true
    for (const timer of restartTimers.values()) clearTimeout(timer)
    restartTimers.clear()
    for (const timer of portTimers.values()) clearInterval(timer)
    portTimers.clear()
    for (const processId of pendingLogs.keys()) flushLogs(processId)
    const processes = [...managed.keys()]
    for (const processId of processes) await stop({ processId })
  }

  kernel.subscribe(({ event }) => {
    if (event.type !== "bot.updated" && event.type !== "bot.deleted") return
    const botId = event.type === "bot.updated" ? event.bot.id : event.botId
    for (const [id, authorization] of processPolicies) {
      if (
        authorization.botId !== botId ||
        (event.type === "bot.updated" && authorization.policy === processPolicy(event.bot))
      )
        continue
      const process = managed.get(id)
      // A namespace cannot narrow existing mounts. Stop the complete tree before
      // a later turn can keep using a removed or downgraded grant.
      stopRequested.add(id)
      if (process) process.stopped = true
      authorization.child.kill("SIGKILL")
    }
  })
  return { define, start, stop, restart, list, logs, previews, openPreview, stopAll, cleanupOrphans, autostart }
}
