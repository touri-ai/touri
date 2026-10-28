import type { SQLQueryBindings } from "bun:sqlite"
import { fileURLToPath } from "node:url"
import { deferWorkerReply } from "../kernel/worker-reply"
import { createStoreReader } from "./reader"

export type BotMetadataStatement = { sql: string; bindings: SQLQueryBindings[] }
export type BotMetadataEdit = {
  botId: string
  select: string
  expected: Record<string, unknown>
  statement: BotMetadataStatement
  instructions?: string | undefined
}

/** One edit owns its helper; instruction frames never copy or serialize the entire edit. */
export const createBotMetadataWriter = (filename: string, onReady?: (pid: number) => void | Promise<void>) => {
  const children = new Set<Bun.Subprocess<"pipe", "pipe", "ignore">>()
  const reader = createStoreReader(filename)
  const tails = new Map<string, Promise<void>>()
  let pending = 0
  let disposed = false

  const executeEdit = async (
    edit: BotMetadataEdit,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> => {
    signal.throwIfAborted()
    if (disposed || children.size >= 8) throw new Error("Bot metadata writer is busy")

    const token = crypto.randomUUID()
    const { instructions } = edit
    const metadata = Object.fromEntries(Object.entries(edit).filter(([key]) => key !== "instructions"))
    const header = JSON.stringify({ filename, token, metadata, hasInstructions: instructions !== undefined })
    if (header.length > 128 * 1024 * 1024) throw new Error("Bot metadata exceeds limit")

    const devArgs = Bun.isStandaloneExecutable
      ? []
      : [fileURLToPath(new URL("./bot-metadata-process.ts", import.meta.url))]
    const child = Bun.spawn([process.execPath, ...devArgs, "bot-metadata"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    children.add(child)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    const abort = () => child.kill("SIGKILL")
    deadline.addEventListener("abort", abort, { once: true })
    const reply = getReply(child.stdout, () => onReady?.(child.pid))
    // A helper may fail while its input is still being flushed.
    void reply.catch(() => undefined)
    try {
      child.stdin.write(`${header}\n`)
      await child.stdin.flush()
      if (instructions !== undefined) await sendInstructions(child.stdin, instructions, deadline)
      await child.stdin.end()
      const [result, code] = await Promise.all([reply, child.exited])
      if (code === 0 && result === "C") return undefined
      if (code === 0 && result.startsWith("{")) return JSON.parse(result) as Record<string, unknown>
      throw new Error("Bot metadata commit failed")
    } catch {
      child.kill("SIGKILL")
      await Promise.allSettled([reply, child.exited])
      // Cancellation can race COMMIT's acknowledgement. Its atomic marker decides whether
      // the home writer may roll back SOUL.md, even after the request disconnects.
      const rows = await reader.getRows<{ value_json: string }>(
        {
          sql: "SELECT value_json FROM settings WHERE key = ?",
          bindings: [`bot-metadata:${edit.botId}`],
          chunkedStrings: true,
        },
        AbortSignal.timeout(5_000),
      )
      const marker = rows[0]
        ? (JSON.parse(rows[0].value_json) as { token: string; row: Record<string, unknown> })
        : undefined
      if (marker?.token === token) return marker.row
      throw new Error("Bot metadata commit failed")
    } finally {
      deadline.removeEventListener("abort", abort)
      children.delete(child)
    }
  }

  const save = async (edit: BotMetadataEdit, signal: AbortSignal): Promise<Record<string, unknown> | undefined> => {
    signal.throwIfAborted()
    if (disposed || pending >= 32) throw new Error("Bot metadata writer is busy")
    pending += 1
    // A bot's commit marker remains authoritative until its acknowledgement is resolved.
    // Other bots have independent tails; queued cancellation cannot roll back a running commit.
    let started = false
    const previous = tails.get(edit.botId) ?? Promise.resolve()
    const result = previous.then(() => {
      started = true
      return executeEdit(edit, signal)
    })
    const tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pending -= 1
        if (tails.get(edit.botId) === tail) tails.delete(edit.botId)
      })
    tails.set(edit.botId, tail)
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => {
      if (!started) cancelled.reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      return await Promise.race([result, cancelled.promise])
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }

  const dispose = async (): Promise<void> => {
    disposed = true
    children.forEach((child) => {
      child.kill("SIGKILL")
    })
    await Promise.all(tails.values())
    reader.dispose()
  }

  return { save, dispose }
}

/** Reserve request order before asynchronous validation, reads or filesystem preparation. */
export const createBotEditQueue = ({ maxPending = 32, maxRetainedBytes = 64 * 1024 * 1024 } = {}) => {
  // Admission counters and tails belong to this scheduler; cancellation keeps retained work accounted for.
  const tails = new Map<string, Promise<void>>()
  const shutdown = new AbortController()
  let pending = 0
  let retainedBytes = 0

  const run = async <Value>(
    {
      botId,
      instructionBytes,
      signal,
    }: {
      botId: string
      instructionBytes: number
      signal: AbortSignal
    },
    action: () => Promise<Value>,
  ): Promise<Value> => {
    const combined = AbortSignal.any([signal, shutdown.signal])
    combined.throwIfAborted()
    if (pending >= maxPending || retainedBytes + instructionBytes > maxRetainedBytes)
      throw new Error("Bot edit capacity exceeded")
    pending += 1
    retainedBytes += instructionBytes
    let started = false
    const previous = tails.get(botId) ?? Promise.resolve()
    const result = previous.then(() => {
      combined.throwIfAborted()
      started = true
      return action()
    })
    const tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pending -= 1
        retainedBytes -= instructionBytes
        if (tails.get(botId) === tail) tails.delete(botId)
      })
    tails.set(botId, tail)
    const cancelled = Promise.withResolvers<never>()
    const cancel = (): void => {
      if (!started) cancelled.reject(combined.reason)
    }
    combined.addEventListener("abort", cancel, { once: true })
    try {
      return await Promise.race([result, cancelled.promise])
    } finally {
      combined.removeEventListener("abort", cancel)
    }
  }

  return {
    run,
    dispose: async (): Promise<void> => {
      shutdown.abort(new Error("Bot edits closed"))
      await Promise.all(tails.values())
    },
  }
}

const sendInstructions = async (stdin: Bun.FileSink, instructions: string, signal: AbortSignal): Promise<void> => {
  // Offsets are local framing state; escaped Unicode and surrogate pairs remain lossless.
  for (let offset = 0; offset < instructions.length; offset += 16_384) {
    signal.throwIfAborted()
    stdin.write(`${JSON.stringify(instructions.slice(offset, offset + 16_384))}\n`)
    await stdin.flush()
    if (offset % (16 * 16_384) === 0) await new Promise<void>(deferWorkerReply)
  }
}

const getReply = async (stdout: ReadableStream<Uint8Array>, onReady: () => void | Promise<void>): Promise<string> => {
  const reader = stdout.getReader()
  const first = await reader.read()
  if (first.done || first.value[0] !== 82) throw new Error("Bot metadata helper failed")
  await onReady()
  const decoder = new TextDecoder()
  // The reply belongs to this edit; read EOF directly even when failure follows the ready byte.
  const chunks = [decoder.decode(first.value.subarray(1), { stream: true })]
  for (;;) {
    const next = await reader.read()
    if (next.done) return chunks.join("") + decoder.decode()

    chunks.push(decoder.decode(next.value, { stream: true }))
  }
}
