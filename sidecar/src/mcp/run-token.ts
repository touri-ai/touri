import { randomBytes } from "node:crypto"
import { join } from "node:path"
import type { Kernel } from "@touri/contracts"
import { removePrivateFileAsync, writePrivateFileAsync } from "../kernel/async-files"

const watchers = new WeakMap<Kernel, Map<string, Set<() => void>>>()
const active = new WeakMap<Kernel, Set<string>>()

export const isRunMcpTokenActive = (kernel: Kernel, path: string) => active.get(kernel)?.has(path) === true

export const watchMcpToken = (kernel: Kernel, path: string, revoked: () => void) => {
  const registry = watchers.get(kernel) ?? new Map<string, Set<() => void>>()
  watchers.set(kernel, registry)
  const listeners = registry.get(path) ?? new Set<() => void>()
  registry.set(path, listeners)
  listeners.add(revoked)
  return () => {
    listeners.delete(revoked)
    if (!listeners.size) registry.delete(path)
  }
}

/** Each preparation owns a credential, including retries of the same run/thread. */
export const createRunMcpToken = async (kernel: Kernel, threadId: string, token: string) => {
  const tokenId = randomBytes(16).toString("hex")
  const path = join(kernel.paths.runDir, "mcp-tokens", `${threadId}.${tokenId}`)
  await writePrivateFileAsync({ root: kernel.paths.appData, path, content: token })
  const tokens = active.get(kernel) ?? new Set<string>()
  active.set(kernel, tokens)
  tokens.add(path)
  let released = false
  return {
    tokenId,
    revoke: () => {
      if (released) return
      released = true
      tokens.delete(path)
      for (const listener of watchers.get(kernel)?.get(path) ?? []) listener()
      watchers.get(kernel)?.delete(path)
      // Authorization and active calls are already revoked, even if disk cleanup fails.
      void removePrivateFileAsync({ root: kernel.paths.appData, path }).catch(() => {
        kernel.log({
          level: "warn",
          module: "mcp",
          msg: "Não foi possível remover um token MCP revogado",
          data: { threadId },
        })
      })
    },
  }
}
