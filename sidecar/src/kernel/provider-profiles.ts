import { join } from "node:path"
import type { Bot, Provider } from "@touri/contracts"

export const PROVIDER_PROFILES_DIR = "provider-profiles"
export const profileProviders = ["claude", "codex"] as const satisfies ReadonlyArray<Provider>
export type ProfileProvider = (typeof profileProviders)[number]

export const isProfileProvider = (provider: Provider): provider is ProfileProvider =>
  (profileProviders as ReadonlyArray<Provider>).includes(provider)

/** Profile names become one path segment, so they stay short and filesystem-neutral. */
export const validProviderProfileName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) && !name.includes("..")

export const providerProfileDir = ({
  appData,
  profile,
  provider,
}: {
  appData: string
  profile: string
  provider: ProfileProvider
}): string => join(appData, PROVIDER_PROFILES_DIR, profile, provider)

/** The CLI home for a profile. Codex keeps everything in CODEX_HOME; Claude in CLAUDE_CONFIG_DIR. */
export const providerProfileVariables = ({
  appData,
  profile,
  provider,
}: {
  appData: string
  profile: string
  provider: ProfileProvider
}): Record<string, string> => {
  const dir = providerProfileDir({ appData, profile, provider })
  return provider === "claude" ? { CLAUDE_CONFIG_DIR: dir } : { CODEX_HOME: dir }
}

/** Child environment overrides for a local bot that signs in with its own profile. */
export const providerProfileEnv = ({
  appData,
  bot,
}: {
  appData: string
  bot: Pick<Bot, "provider" | "machine" | "providerProfile">
}): Record<string, string> => {
  const profile = bot.providerProfile
  if (!profile || bot.machine !== "local" || !isProfileProvider(bot.provider)) return {}
  if (!validProviderProfileName(profile)) return {}
  return providerProfileVariables({ appData, profile, provider: bot.provider })
}
