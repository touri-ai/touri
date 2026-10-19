import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Kernel } from "@touri/contracts"
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  movePrivateFile,
  readPrivateFile,
  removePrivateFile,
  removePrivateTree,
} from "../kernel/files"

export type BotHomeCommand =
  | { operation: "write" | "edit"; botId: string; instructions: string }
  | { operation: "remove" | "snapshot" | "commit" | "rollback"; botId: string }

type Helper = { execute: (command: BotHomeCommand) => Promise<void>; stop: () => Promise<void> }
const INPUT_LIMIT = 128 * 1024
// Content frames stay small; decoded edits can fill the existing HTTP body allowance.
const EDIT_INPUT_LIMIT = 32 * 1024 * 1024
const CONTENT_CHUNK_LENGTH = 16 * 1024
const PENDING_BYTE_LIMIT = 4 * 1024 * 1024

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

export const updateBotHome = async (
  kernel: Kernel,
  botId: string,
  instructions: string,
  signal: AbortSignal,
  prepare: () => { commit: () => void },
  writer = getWriter(kernel),
): Promise<void> => {
  await writer.run({ operation: "edit", botId, instructions }, signal, {
    prepare,
    onRollbackFailure: () =>
      kernel.log({ level: "error", module: "store", msg: "Could not restore bot home after an instruction edit" }),
  })
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

/** At most 32 commands; an idle FIFO also admits one edit up to the HTTP body allowance. */
export const createBotHomeWriter = ({
  root,
  createHelper = () => startBotHomeHelper(root),
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
  let pendingBytes = 0
  let tail: Promise<void> = Promise.resolve()
  let helper: Helper | undefined
  const shutdown = new AbortController()

  const run = async (
    command: BotHomeCommand,
    signal?: AbortSignal,
    options?: {
      prepare?: () => { commit?: () => void }
      commit?: () => void
      onRollbackFailure?: () => void
    },
  ): Promise<void> => {
    shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
    validateBotHomeCommand(command)
    // Count retained UTF-16 storage without scanning or JSON-escaping the instruction text.
    const operationBytes = 256 + ("instructions" in command ? command.instructions.length * 2 : 0)
    if (pending >= maxPending || (pending > 0 && pendingBytes + operationBytes > PENDING_BYTE_LIMIT))
      throw new Error("Bot home writer is busy")

    pending += 1
    pendingBytes += operationBytes
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error("Bot home operation timed out")), timeoutMs)
    const combined = AbortSignal.any([shutdown.signal, deadline.signal, ...(signal ? [signal] : [])])
    let started = false
    const execute = tail.then(async () => {
      combined.throwIfAborted()
      started = true
      const isEdit = command.operation === "edit"
      let snapshotStarted = false
      try {
        const commit = options?.prepare?.().commit ?? options?.commit
        if (isEdit) {
          snapshotStarted = true
          await executeWithHelper({ operation: "snapshot", botId: command.botId }, combined)
        }
        await executeWithHelper(command, combined)
        combined.throwIfAborted()
        commit?.()
      } catch (error) {
        if (snapshotStarted) await finishEdit("rollback", command.botId, options?.onRollbackFailure)
        throw combined.aborted ? combined.reason : error
      }
      // The database is committed: cancellation or cleanup failure must never restore the old file.
      if (isEdit) await finishEdit("commit", command.botId, options?.onRollbackFailure)
    })
    tail = execute
      .catch(() => undefined)
      .finally(() => {
        pending -= 1
        pendingBytes -= operationBytes
      })

    // Queued cancellation returns promptly; its slot stays reserved until the FIFO reaches it.
    const cancelled = Promise.withResolvers<never>()
    const restoresOnFailure = command.operation === "edit"
    const cancel = () => {
      if (!started || !restoresOnFailure) cancelled.reject(combined.reason)
    }
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
    await helper?.stop()
  }

  const executeWithHelper = async (command: BotHomeCommand, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    helper ??= createHelper()
    const active = helper
    const cancel = () => void active.stop()
    signal.addEventListener("abort", cancel, { once: true })
    try {
      await active.execute(command)
      signal.throwIfAborted()
    } catch (error) {
      await active.stop()
      helper = undefined
      throw signal.aborted ? signal.reason : error
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }

  const finishEdit = async (operation: "commit" | "rollback", botId: string, onFailure?: () => void) => {
    try {
      await executeWithHelper({ operation, botId }, AbortSignal.timeout(timeoutMs))
    } catch {
      try {
        onFailure?.()
      } catch {}
    }
  }

  return { run, close }
}

export const startBotHomeHelper = (root: string): Helper => {
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
  const sendFrame = async (bytes: Buffer) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(bytes.length)
    child.stdin.write(prefix)
    child.stdin.write(bytes)
    await child.stdin.flush()
  }
  const sendInstructions = async (instructions: string) => {
    // Local offsets keep UTF-8 chunks bounded and never split a surrogate pair.
    for (let offset = 0; offset < instructions.length; ) {
      let end = Math.min(offset + CONTENT_CHUNK_LENGTH, instructions.length)
      const last = instructions.charCodeAt(end - 1)
      if (end < instructions.length && last >= 0xd800 && last <= 0xdbff) end -= 1
      await sendFrame(Buffer.from(instructions.slice(offset, end)))
      offset = end
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await sendFrame(Buffer.alloc(0))
  }
  return {
    execute: async (command) => {
      await ready
      const header = command.operation === "edit" ? { ...command, instructions: "" } : command
      await sendFrame(Buffer.from(JSON.stringify(header)))
      if (command.operation === "edit") await sendInstructions(command.instructions)
      await getReply(49)
    },
    stop: async () => {
      child.kill("SIGKILL")
      await child.exited
    },
  }
}

const validateBotHomeCommand = (command: BotHomeCommand): void => {
  if (command.operation === "edit") {
    if (command.instructions.length > EDIT_INPUT_LIMIT) throw new Error("Bot home input exceeds limit")
    getBotHomeCommand(JSON.stringify({ ...command, instructions: "" }))
    return
  }
  getBotHomeCommand(JSON.stringify(command))
}

export const getBotHomeCommand = (text: string): BotHomeCommand => {
  if (Buffer.byteLength(text) > INPUT_LIMIT) throw new Error("Bot home input exceeds limit")
  const input: unknown = JSON.parse(text)
  if (!input || typeof input !== "object" || !("operation" in input) || !("botId" in input))
    throw new Error("Invalid bot home command")
  if (typeof input.botId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.botId)) throw new Error("Invalid bot id")
  if (
    (input.operation === "remove" ||
      input.operation === "snapshot" ||
      input.operation === "commit" ||
      input.operation === "rollback") &&
    Object.keys(input).every((key) => ["operation", "botId"].includes(key))
  )
    return { operation: input.operation, botId: input.botId }
  if (
    (input.operation !== "write" && input.operation !== "edit") ||
    !("instructions" in input) ||
    typeof input.instructions !== "string"
  )
    throw new Error("Invalid bot home command")
  if (Object.keys(input).some((key) => !["operation", "botId", "instructions"].includes(key)))
    throw new Error("Invalid bot home command")
  return { operation: input.operation, botId: input.botId, instructions: input.instructions }
}

const executeBotHomeCommand = (root: string, command: BotHomeCommand, content?: Buffer): void => {
  // Synchronous descriptor-relative operations are isolated in this helper, never on the request loop.
  const home = join(root, "bots", command.botId)
  const soul = join(home, "SOUL.md")
  const backup = join(home, ".SOUL.edit-backup")
  if (command.operation === "remove") {
    removePrivateTree({ root, path: home })
    return
  }
  ensurePrivateDirectory({ root, path: home })
  if (command.operation === "snapshot") {
    if (readPrivateFile({ root, path: soul, maxBytes: 1 }) === null) {
      atomicWriteFile({ root, path: backup, content: "" })
      return
    }
    movePrivateFile({ root, from: soul, to: backup })
    return
  }
  if (command.operation === "rollback") {
    if (readPrivateFile({ root, path: backup, maxBytes: 1 }) !== null) movePrivateFile({ root, from: backup, to: soul })
    return
  }
  if (command.operation === "commit") {
    removePrivateFile({ root, path: backup })
    return
  }
  if ("instructions" in command) atomicWriteFile({ root, path: soul, content: content ?? command.instructions })
}

/** Each frame is bounded independently; old instructions never cross the process boundary. */
export const runBotHomeWriter = async (root: string): Promise<void> => {
  const getFrame = getFrameReader(Bun.stdin.stream())
  process.stdout.write("R")
  for (;;) {
    const frame = await getFrame()
    if (frame === null) return
    const command = getBotHomeCommand(frame.toString("utf8"))
    const content = command.operation === "edit" ? await getInstructionContent(getFrame) : undefined
    try {
      executeBotHomeCommand(root, command, content)
      process.stdout.write("1")
    } catch {
      process.stdout.write("0")
    }
  }
}

const getInstructionContent = async (getFrame: () => Promise<Buffer | null>): Promise<Buffer> => {
  // The helper owns this bounded accumulation; no instruction-size copy runs on the request loop.
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const chunk = await getFrame()
    if (chunk === null) throw new Error("Incomplete bot home command")
    if (!chunk.length) return Buffer.concat(chunks, size)
    size += chunk.length
    if (size > EDIT_INPUT_LIMIT) throw new Error("Bot home input exceeds limit")
    chunks.push(chunk)
  }
}

const getFrameReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  // Parsing state is local to this stream; each allocated frame is at most 128 KiB.
  let buffer: Uint8Array = new Uint8Array(0)
  let offset = 0
  const getBytes = async (length: number): Promise<Buffer | null> => {
    const bytes = Buffer.alloc(length)
    let written = 0
    while (written < length) {
      if (offset === buffer.length) {
        const next = await reader.read()
        if (next.done) {
          if (written === 0) return null
          throw new Error("Incomplete bot home command")
        }
        buffer = next.value
        offset = 0
      }
      const count = Math.min(length - written, buffer.length - offset)
      bytes.set(buffer.subarray(offset, offset + count), written)
      written += count
      offset += count
    }
    return bytes
  }
  return async (): Promise<Buffer | null> => {
    const prefix = await getBytes(4)
    if (prefix === null) return null
    const length = prefix.readUInt32BE()
    if (length > INPUT_LIMIT) throw new Error("Bot home input exceeds limit")
    const bytes = await getBytes(length)
    if (bytes === null) throw new Error("Incomplete bot home command")
    return bytes
  }
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
