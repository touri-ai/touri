import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ProviderProfile } from "@touri/contracts"
import {
  PROVIDER_PROFILES_DIR,
  profileProviders,
  providerProfileDir,
  validProviderProfileName,
} from "../kernel/provider-profiles"
import { buildChildEnv } from "../kernel/shell-env"
import { resolveExecutable } from "./utils"

const STATUS_TIMEOUT_MS = 10_000

const claudeStatus = async ({
  dir,
  env,
}: {
  dir: string
  env: Record<string, string>
}): Promise<{ loggedIn: boolean; account: string | null }> => {
  const childEnv = buildChildEnv({ base: env, overrides: { CLAUDE_CONFIG_DIR: dir } })
  const resolved = resolveExecutable({ command: process.env.TOURI_CLAUDE_BIN ?? "claude", env: childEnv })
  if (!resolved.success) return { loggedIn: false, account: null }
  try {
    const child = Bun.spawn({
      cmd: [resolved.path, "auth", "status", "--json"],
      env: childEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })
    const output = await new Response(child.stdout).text()
    await child.exited
    const status = JSON.parse(output) as { loggedIn?: unknown; email?: unknown }
    const loggedIn = status.loggedIn === true
    return { loggedIn, account: loggedIn && typeof status.email === "string" ? status.email : null }
  } catch {
    return { loggedIn: false, account: null }
  }
}

/** Lists the profiles on disk. Credentials are never read; Claude reports its own status. */
export const listProviderProfiles = async ({
  appData,
  env,
}: {
  appData: string
  env: Record<string, string>
}): Promise<Array<ProviderProfile>> => {
  const root = join(appData, PROVIDER_PROFILES_DIR)
  if (!existsSync(root)) return []
  const profiles: Array<Promise<ProviderProfile>> = []
  for (const name of readdirSync(root).sort()) {
    if (!validProviderProfileName(name)) continue
    for (const provider of profileProviders) {
      const dir = providerProfileDir({ appData, profile: name, provider })
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
      profiles.push(
        provider === "claude"
          ? claudeStatus({ dir, env }).then((status) => ({ name, provider, ...status }))
          : Promise.resolve({ name, provider, loggedIn: existsSync(join(dir, "auth.json")), account: null }),
      )
    }
  }
  return Promise.all(profiles)
}
