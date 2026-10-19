import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Kernel } from "@touri/contracts"
import { atomicWriteFile, ensurePrivateDirectory, removePrivateTree } from "../kernel/files"

export type BotHomeCommand =
  | { operation: "write"; botId: string; instructions: string }
  | { operation: "remove"; botId: string }

type Helper = { execute: (command: string) => Promise<void>; stop: () => Promise<void> }
const INPUT_LIMIT = 128 * 1024

// Each kernel owns one helper; shutdown explicitly releases it before closing the database.
const writers = new WeakMap<Kernel, ReturnType<typeof createBotHomeWriter>>()

/** Run the descriptor-relative writer off the live event loop, including compiled releases. */
export const writeBotHome = async (
  kernel: Kernel,
  botId: string,
  instructions: string,
  signal: AbortSignal,
): Promise<string> => {
  signal.throwIfAborted()
  try {
    await getWriter(kernel).run({ operation: "write", botId, instructions }, signal)
  } catch (error) {
    await cleanupBotHome(kernel, botId)
    throw error
  }
  return join(kernel.paths.botsDir, botId)
}

export const removeBotHome = async (kernel: Kernel, botId: string): Promise<void> => {
  await getWriter(kernel).run({ operation: "remove", botId })
}

/** Cleanup must never replace the original write, cancellation or database error. */
export const cleanupBotHome = async (kernel: Kernel, botId: string): Promise<void> => {
  try {
    await removeBotHome(kernel, botId)
  } catch {
    kernel.log({ level: "warn", module: "store", msg: "Could not remove uncommitted bot home" })
  }
}

export const stopBotHomeWriter = (kernel: Kernel): Promise<void> | undefined => {
  const writer = writers.get(kernel)
  if (!writer) return undefined

  return writer.close().finally(() => writers.delete(kernel))
}

const getWriter = (kernel: Kernel) => {
  const existing = writers.get(kernel)
  if (existing) return existing

  const writer = createBotHomeWriter({ root: kernel.paths.appData })
  writers.set(kernel, writer)
  return writer
}

/** A bounded FIFO admits at most 32 commands (4 MiB) and runs only one helper at a time. */
export const createBotHomeWriter = ({
  root,
  createHelper = () => startHelper(root),
  timeoutMs = 10_000,
  maxPending = 32,
}: {
  root: string
  createHelper?: () => Helper
  timeoutMs?: number
  maxPending?: number
}) => {
  // Admission and the promise tail are local mutable state required to serialize helper I/O.
  let pending = 0
  let tail: Promise<void> = Promise.resolve()
  let helper: Helper | undefined
  const shutdown = new AbortController()

  const run = async (command: BotHomeCommand, signal?: AbortSignal): Promise<void> => {
    shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
    const input = JSON.stringify(command)
    getBotHomeCommand(input)
    if (pending >= maxPending) throw new Error("Bot home writer is busy")

    pending += 1
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error("Bot home operation timed out")), timeoutMs)
    const combined = AbortSignal.any([shutdown.signal, deadline.signal, ...(signal ? [signal] : [])])
    const execute = tail.then(async () => {
      combined.throwIfAborted()
      helper ??= createHelper()
      const active = helper
      const cancel = () => void active.stop()
      combined.addEventListener("abort", cancel, { once: true })
      try {
        await active.execute(input)
        combined.throwIfAborted()
      } catch (error) {
        await active.stop()
        helper = undefined
        throw combined.aborted ? combined.reason : error
      } finally {
        combined.removeEventListener("abort", cancel)
      }
    })
    tail = execute
      .catch(() => undefined)
      .finally(() => {
        pending -= 1
      })

    // Queued cancellation returns promptly; its slot stays reserved until the FIFO reaches it.
    const cancelled = Promise.withResolvers<never>()
    const cancel = () => cancelled.reject(combined.reason)
    combined.addEventListener("abort", cancel, { once: true })
    try {
      return await Promise.race([execute, cancelled.promise])
    } finally {
      clearTimeout(timer)
      combined.removeEventListener("abort", cancel)
    }
  }

  const close = async (): Promise<void> => {
    shutdown.abort(new Error("Bot home writer is closed"))
    await helper?.stop()
    await tail
  }
  return { run, close }
}

const startHelper = (root: string): Helper => {
  const devArgs = /^bun(?:\.exe)?$/.test(basename(process.execPath)) ? [fileURLToPath(import.meta.url)] : []
  const child = Bun.spawn([process.execPath, ...devArgs, "write-bot-home"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, TOURI_APP_DATA: root },
  })
  const reader = child.stdout.getReader()
  const getReply = async (expected: number): Promise<void> => {
    const reply = await reader.read()
    if (reply.done || reply.value.length !== 1 || reply.value[0] !== expected)
      throw new Error("Bot home operation failed")
  }
  const ready = getReply(82)
  // A caller can cancel while startup is still in progress.
  void ready.catch(() => undefined)
  return {
    execute: async (command) => {
      await ready
      child.stdin.write(`${command}\n`)
      await child.stdin.flush()
      await getReply(49)
    },
    stop: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

export const getBotHomeCommand = (text: string): BotHomeCommand => {
  if (Buffer.byteLength(text) > INPUT_LIMIT) throw new Error("Bot home input exceeds limit")
  const input: unknown = JSON.parse(text)
  if (!input || typeof input !== "object" || !("operation" in input) || !("botId" in input))
    throw new Error("Invalid bot home command")
  if (typeof input.botId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.botId)) throw new Error("Invalid bot id")
  if (input.operation === "remove" && Object.keys(input).every((key) => ["operation", "botId"].includes(key)))
    return { operation: "remove", botId: input.botId }
  if (input.operation !== "write" || !("instructions" in input) || typeof input.instructions !== "string")
    throw new Error("Invalid bot home command")
  if (Object.keys(input).some((key) => !["operation", "botId", "instructions"].includes(key)))
    throw new Error("Invalid bot home command")
  return { operation: "write", botId: input.botId, instructions: input.instructions }
}

const executeBotHomeCommand = (root: string, command: BotHomeCommand): void => {
  // Synchronous descriptor-relative operations are isolated in this helper, never on the request loop.
  const home = join(root, "bots", command.botId)
  if (command.operation === "remove") {
    removePrivateTree({ root, path: home })
    return
  }
  ensurePrivateDirectory({ root, path: home })
  atomicWriteFile({ root, path: join(home, "SOUL.md"), content: command.instructions })
}

/** Only the admitted head is sent; input is bounded independently at the helper boundary. */
export const runBotHomeWriter = async (root: string): Promise<void> => {
  process.stdout.write("R")
  // A streaming frame can cross chunks; keep its bounded remainder local to this reader.
  let buffer = Buffer.alloc(0)
  const reader = Bun.stdin.stream().getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer = Buffer.concat([buffer, chunk.value])
    if (buffer.length > INPUT_LIMIT + 1) throw new Error("Bot home input exceeds limit")
    if (buffer[buffer.length - 1] !== 10) continue

    try {
      executeBotHomeCommand(root, getBotHomeCommand(buffer.subarray(0, -1).toString("utf8")))
      process.stdout.write("1")
    } catch {
      process.stdout.write("0")
    }
    buffer = Buffer.alloc(0)
  }
  if (buffer.length) throw new Error("Incomplete bot home command")
}

// Development invokes this small entry directly; compiled entries dispatch the same protocol.
if (import.meta.main) {
  try {
    const root = process.env.TOURI_APP_DATA
    if (!root) throw new Error("Missing app data")
    await runBotHomeWriter(root)
  } catch {
    process.exitCode = 1
  }
}
