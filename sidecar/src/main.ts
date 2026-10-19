import { readFileSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { isAbsolute, relative, resolve } from "node:path"
import type { Kernel } from "@touri/contracts"
import { createKernel, type KernelRuntime } from "./kernel"
import { closeFileIoAsync } from "./kernel/async-files"
import { acquireRuntimeLock, watchParent, watchShutdownRequest } from "./kernel/lifecycle"
import { createAppPaths } from "./kernel/paths"
import type { PerformanceStageRunner } from "./kernel/performance"
import { safeThreadId } from "./mcp/auth"
import { registerShim } from "./mcp/shim-registry"
import { type McpShimStage, mcpStartupFailureLine } from "./mcp/startup-stage"
import { connectionOptions, resolveMcpEndpoint } from "./platform/transport"

const STDIN_EOF_GRACE_MS = 1_000

type ModuleLoader = { path: string; load: () => Promise<unknown> }

const moduleLoaders: Array<ModuleLoader> = [
  { path: "./store/index.ts", load: () => import("./store/index.js") },
  { path: "./api-models/index.ts", load: () => import("./api-models/index.js") },
  { path: "./reports/index.ts", load: () => import("./reports/index.js") },
  { path: "./groups/index.ts", load: () => import("./groups/index.js") },
  { path: "./notify/index.ts", load: () => import("./notify/index.js") },
  { path: "./vm/module.ts", load: () => import("./vm/module.js") },
  { path: "./mcp/index.ts", load: () => import("./mcp/index.js") },
  { path: "./projects/index.ts", load: () => import("./projects/index.js") },
  { path: "./mem0/index.ts", load: () => import("./mem0/index.js") },
  { path: "./browser/index.ts", load: () => import("./browser/index.js") },
  { path: "./computer/index.ts", load: () => import("./computer/index.js") },
  { path: "./runtime/index.ts", load: () => import("./runtime/index.js") },
  { path: "./integrations/telegram/index.ts", load: () => import("./integrations/telegram/index.js") },
  { path: "./learning/index.ts", load: () => import("./learning/index.js") },
  { path: "./importer/index.ts", load: () => import("./importer/index.js") },
]

type ModuleShape = {
  name?: string
  init?: (kernel: Kernel, runStage?: PerformanceStageRunner) => Promise<void> | void
}

const asModule = (value: unknown): ModuleShape => {
  if (typeof value !== "object" || value === null) return {}
  const candidate = value as Record<string, unknown>
  const result: ModuleShape = {}
  if (typeof candidate.name === "string") result.name = candidate.name
  if (typeof candidate.init === "function") result.init = candidate.init as NonNullable<ModuleShape["init"]>
  return result
}

const isContained = ({ root, candidate }: { root: string; candidate: string }): boolean => {
  const child = relative(root, candidate)
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child)
}

export const initModules = async (runtime: KernelRuntime): Promise<void> => {
  for (const module of moduleLoaders) {
    const started = performance.now()
    const imported = await module.load().then(
      (value: unknown) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const loadedAt = performance.now()
    if (!imported.ok) {
      runtime.kernel.log({
        level: "info",
        module: "main",
        msg: `skipping missing module ${module.path}`,
        data: { error: imported.error instanceof Error ? imported.error.message : String(imported.error) },
      })
      continue
    }
    const loaded = asModule(imported.value)
    if (!loaded.init) {
      runtime.kernel.log({ level: "info", module: "main", msg: `skipping missing module ${module.path}` })
      continue
    }
    try {
      await loaded.init(runtime.kernel, runtime.runStage)
      runtime.kernel.log({
        level: "info",
        module: "main",
        msg: `initialized module ${module.path}`,
        data: { loadMs: Math.round(loadedAt - started), initMs: Math.round(performance.now() - loadedAt) },
      })
    } catch (error) {
      runtime.kernel.log({
        level: "error",
        module: "main",
        msg: `module init failed ${module.path}`,
        data: {
          error: error instanceof Error ? error.message : String(error),
          loadMs: Math.round(loadedAt - started),
          initMs: Math.round(performance.now() - loadedAt),
        },
      })
    }
  }
  runtime.kernel.services.use("doctor")?.start()
}

const runServe = async (): Promise<void> => {
  const lease = await acquireRuntimeLock(createAppPaths())
  const runtime = createKernel()
  let initialization = Promise.resolve()
  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(1), 10_000)
    deadline.unref()
    void (async () => {
      await initialization
      await runtime.kernel.services.use("runtime.shutdown")?.()
      runtime.emitHostNotification({ method: "app.willQuit", params: {} })
      await runtime.kernel.services.use("vm.shutdown")?.()
      await runtime.stop()
      await closeFileIoAsync()
      lease.release()
      process.exit(0)
    })().catch(async (error) => {
      runtime.kernel.log({
        level: "error",
        module: "main",
        msg: "Falha ao encerrar o runtime",
        data: { error: String(error) },
      })
      await closeFileIoAsync().catch(() => undefined)
      process.exit(1)
    })
  }
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)
  watchParent(shutdown)
  watchShutdownRequest(shutdown)
  if (stopping) return
  initialization = initModules(runtime)
  await initialization
  if (!stopping) process.stdout.write(`${JSON.stringify(runtime.handshake)}\n`)
}

/** Some provider CLIs discard child stderr. Return a protocol error to their initialize request too. */
const rejectMcpInitialize = (stage: McpShimStage): Promise<void> => {
  const message = mcpStartupFailureLine({ stage })
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return new Promise((resolve) => {
    let buffer = ""
    const finish = (id?: string | number): void => {
      clearTimeout(timer)
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.off("error", onEnd)
      process.stdin.pause()
      if (id === undefined) resolve()
      else
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`, () =>
          resolve(),
        )
    }
    const onEnd = (): void => finish()
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8")
      if (buffer.length > 65_536) {
        finish()
        return
      }
      if (!buffer.includes("\n")) return
      try {
        const frame = JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
        finish(
          frame?.method === "initialize" && (typeof frame.id === "string" || typeof frame.id === "number")
            ? frame.id
            : undefined,
        )
      } catch {
        finish()
      }
    }
    const timer = setTimeout(onEnd, 1000)
    process.stdin.on("data", onData)
    process.stdin.once("end", onEnd)
    process.stdin.once("error", onEnd)
  })
}

export const runMcpStdio = ({ threadId, appData }: { threadId: string; appData?: string }): Promise<void> => {
  if (!safeThreadId(threadId)) {
    process.stderr.write("Invalid MCP thread id\n")
    process.exitCode = 1
    return Promise.resolve()
  }
  const paths = appData === undefined ? createAppPaths() : createAppPaths({ appData })
  const tokenDir = resolve(paths.runDir, "mcp-tokens")
  const tokenPath = resolve(tokenDir, threadId)
  if (!isContained({ root: tokenDir, candidate: tokenPath })) {
    process.stderr.write("Invalid MCP token path\n")
    process.exitCode = 1
    return Promise.resolve()
  }
  let token: string
  try {
    token = readFileSync(tokenPath, "utf8").trim()
    if (!token) throw new Error("Empty MCP token")
  } catch {
    return rejectMcpInitialize("token_unavailable")
  }
  let socket: Socket
  try {
    const socketPath = process.env.TOURI_MCP_SOCK ?? resolveMcpEndpoint(paths)
    socket = createConnection(connectionOptions(socketPath))
  } catch {
    return rejectMcpInitialize("socket_error")
  }
  // Registration probes `ps` in the background so it never delays the MCP handshake.
  const registration = registerShim({ runDir: paths.runDir, thread: threadId })
  return new Promise((resolve) => {
    const state = { answered: false, finished: false }
    let stopWatching: () => void = () => undefined
    const finish = (reason: McpShimStage): void => {
      if (state.finished) return
      state.finished = true
      const rejected = !state.answered && reason === "socket_error" ? rejectMcpInitialize(reason) : Promise.resolve()
      if (!state.answered && reason !== "socket_error")
        process.stderr.write(`${mcpStartupFailureLine({ stage: reason })}\n`)
      stopWatching()
      socket.destroy()
      // The caller exits right after; drop this shim's record first.
      void Promise.all([rejected, registration.then((unregister) => unregister())]).finally(() =>
        process.stdout.write("", () => resolve()),
      )
    }
    const onStdinEnd = (): void => {
      setTimeout(() => finish("stdin_closed"), STDIN_EOF_GRACE_MS).unref()
    }
    socket.once("error", () => {
      process.exitCode = 1
      finish("socket_error")
    })
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ touriAuth: { thread: threadId, token } })}\n`)
      process.stdin.pipe(socket, { end: false })
      socket.pipe(process.stdout)
    })
    socket.on("data", () => {
      state.answered = true
    })
    socket.once("close", () => finish("closed_before_initialize"))
    process.stdin.once("end", onStdinEnd)
    process.stdin.once("close", onStdinEnd)
    process.once("SIGTERM", () => finish("terminated"))
    stopWatching = watchParent(() => finish("parent_gone"), process.ppid)
  })
}

const usage = (): void => {
  process.stderr.write("Usage: touri-sidecar serve | mcp-stdio --thread <id>\n")
  process.exitCode = 2
}

const main = async (): Promise<void> => {
  const [mode = "serve", ...rest] = process.argv.slice(2)
  if (mode === "write-bot-home") {
    const { runBotHomeWriter } = await import("./store/bot-home")
    try {
      await runBotHomeWriter(createAppPaths().appData)
    } catch {
      process.exitCode = 1
    }
    return
  }
  if (mode === "serve") {
    await runServe()
    return
  }
  if (mode === "mcp-stdio") {
    const threadIndex = rest.indexOf("--thread")
    const threadId = threadIndex >= 0 ? rest[threadIndex + 1] : undefined
    if (!threadId) {
      usage()
      return
    }
    await runMcpStdio({ threadId })
    process.exit(process.exitCode ?? 0)
  }
  usage()
}

if (import.meta.main) await main()
