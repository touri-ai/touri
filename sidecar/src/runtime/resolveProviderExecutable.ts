import type { AbsolutePath, Kernel, Result } from "@touri/contracts"
import { withToolPath } from "../kernel/shell-env"
import { resolveExecutable } from "./utils"

export type ResolveProviderExecutableArgs = {
  kernel: Kernel
  command: string
  env: Record<string, string>
}
export type ResolveProviderExecutableSuccess = { success: true; path: AbsolutePath; env: Record<string, string> }
export type ResolveProviderExecutableError = { success: false; errorCode: "cli_missing"; error: string }
export type ResolveProviderExecutableResult = ResolveProviderExecutableSuccess | ResolveProviderExecutableError

const shellPath = async (kernel: Kernel): Promise<string | null> => {
  try {
    return (await kernel.shellEnv()).PATH ?? null
  } catch {
    return null
  }
}

/** Resolve the provider CLI dynamically: configured path, then the child PATH, then the login-shell PATH. */
export const resolveProviderExecutable = async ({
  kernel,
  command,
  env,
}: ResolveProviderExecutableArgs): Promise<ResolveProviderExecutableResult> => {
  env = { ...env, PATH: withToolPath(env).PATH }
  const direct: Result<{ path: AbsolutePath }, "cli_missing"> = resolveExecutable({ command, env })
  if (direct.success) return { success: true, path: direct.path, env }
  const path = await shellPath(kernel)
  if (!path) return direct
  const widened = { ...env, PATH: [env.PATH, path].filter(Boolean).join(":") }
  const retried = resolveExecutable({ command, env: widened })
  return retried.success ? { success: true, path: retried.path, env: widened } : direct
}
