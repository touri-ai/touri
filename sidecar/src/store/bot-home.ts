import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Kernel } from "@touri/contracts"
import { atomicWriteFile, ensurePrivateDirectory, removePrivateTree } from "../kernel/files"

type BotHomeCommand =
  | { operation: "write"; botId: string; instructions: string }
  | { operation: "remove"; botId: string }

/** Run the existing descriptor-relative writer off the live event loop, also in compiled releases. */
export const writeBotHome = async (
  kernel: Kernel,
  botId: string,
  instructions: string,
  signal: AbortSignal,
): Promise<string> => {
  signal.throwIfAborted()
  try {
    await runBotHomeCommand(kernel, { operation: "write", botId, instructions }, signal)
  } catch (error) {
    await removeBotHome(kernel, botId)
    throw error
  }
  return join(kernel.paths.botsDir, botId)
}

export const removeBotHome = async (kernel: Kernel, botId: string): Promise<void> => {
  await runBotHomeCommand(kernel, { operation: "remove", botId })
}

const runBotHomeCommand = async (kernel: Kernel, command: BotHomeCommand, signal?: AbortSignal): Promise<void> => {
  const devArgs = /^bun(?:\.exe)?$/.test(basename(process.execPath)) ? [fileURLToPath(import.meta.url)] : []
  const child = Bun.spawn([process.execPath, ...devArgs, "write-bot-home"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, TOURI_APP_DATA: kernel.paths.appData },
  })
  const cancel = () => child.kill("SIGKILL")
  const timer = setTimeout(cancel, 10_000)
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) cancel()
    child.stdin.write(JSON.stringify(command))
    await child.stdin.end()
    const code = await child.exited
    if (code !== 0 || signal?.aborted) throw new Error("Bot home operation failed")
  } catch (error) {
    child.kill("SIGKILL")
    await child.exited
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    child.kill()
  }
}

/** One-shot subprocess: bounded input, no server or live callbacks; preserves the secure file writer. */
export const runBotHomeWriter = async (root: string): Promise<void> => {
  const reader = Bun.stdin.stream().getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytes += chunk.value.length
    if (bytes > 128 * 1024) throw new Error("Bot home input exceeds limit")
    chunks.push(chunk.value)
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!input || typeof input !== "object" || !("operation" in input) || !("botId" in input))
    throw new Error("Invalid bot home command")
  if (typeof input.botId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.botId)) throw new Error("Invalid bot id")
  const home = join(root, "bots", input.botId)
  if (input.operation === "remove") {
    if (Object.keys(input).some((key) => !["operation", "botId"].includes(key)))
      throw new Error("Invalid bot home command")
    removePrivateTree({ root, path: home })
    return
  }
  if (input.operation !== "write" || !("instructions" in input) || typeof input.instructions !== "string")
    throw new Error("Invalid bot home command")
  if (Object.keys(input).some((key) => !["operation", "botId", "instructions"].includes(key)))
    throw new Error("Invalid bot home command")
  ensurePrivateDirectory({ root, path: home })
  atomicWriteFile({ root, path: join(home, "SOUL.md"), content: input.instructions })
}

// Development invokes this small entry directly, without bootstrapping the sidecar's module graph.
if (import.meta.main) {
  try {
    const root = process.env.TOURI_APP_DATA
    if (!root) throw new Error("Missing app data")
    await runBotHomeWriter(root)
  } catch {
    process.exitCode = 1
  }
}
