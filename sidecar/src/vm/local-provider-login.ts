import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { ensurePrivateDirectoryAsync, removePrivateFileAsync, writePrivateFileAsync } from "../kernel/async-files"
import { prepareHostCodexHome } from "../runtime/codex/home"
import { loginTarget, readProviderLogin, redactProviderLogin, storedProviderLoginSource } from "./provider-login"

const codexLoginLeases = new Map<string, number>()

/** Keep rollouts durable while releasing credentials only after the bot's last local turn. */
const prepareVaultCodexHome = async (kernel: Kernel, bot: Bot, login: string) => {
  // A separate home never replaces the host-login home's shared authentication link.
  const home = join(kernel.paths.appData, "provider-homes/codex-vault", bot.id)
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: home })
  await writePrivateFileAsync({
    root: kernel.paths.appData,
    path: join(home, "config.toml"),
    content: 'cli_auth_credentials_store = "file"\n',
  })
  const auth = join(home, "auth.json")
  await writePrivateFileAsync({ root: kernel.paths.appData, path: auth, content: login })
  codexLoginLeases.set(home, (codexLoginLeases.get(home) ?? 0) + 1)
  let released = false
  return {
    env: { CODEX_HOME: home },
    release: async () => {
      if (released) return
      released = true
      const remaining = (codexLoginLeases.get(home) ?? 1) - 1
      if (remaining > 0) {
        codexLoginLeases.set(home, remaining)
        return
      }
      codexLoginLeases.delete(home)
      await removePrivateFileAsync({ root: kernel.paths.appData, path: auth })
    },
  }
}

/** Prepare a persistent host-login home or temporary vault credentials for a local CLI turn. */
export const prepareLocalProviderLogin = async (
  kernel: Kernel,
  bot: Bot,
  signal: AbortSignal,
  hostHome = homedir(),
): Promise<{ env: Record<string, string>; release: () => Promise<void> | void }> => {
  signal.throwIfAborted()
  if (bot.provider === "opencode" && bot.model?.startsWith("touri-api-")) return { env: {}, release: () => {} }
  if (storedProviderLoginSource(kernel, bot) !== "vault") {
    if (bot.provider === "codex" && bot.machine === "local" && !bot.providerProfile)
      return {
        env: { CODEX_HOME: await prepareHostCodexHome(kernel.paths.appData, bot.id, hostHome) },
        release: () => {},
      }
    return { env: {}, release: () => {} }
  }
  const login = await readProviderLogin(kernel, bot, hostHome, { signal })
  signal.throwIfAborted()
  redactProviderLogin(kernel, login.value)
  if (bot.provider === "claude") return { env: { CLAUDE_CODE_OAUTH_TOKEN: login.value }, release: () => {} }
  if (bot.provider === "codex") return prepareVaultCodexHome(kernel, bot, login.value)
  const directory = await mkdtemp(join(kernel.paths.runDir, "provider-turn-"))
  try {
    await chmod(directory, 0o700)
    const target = loginTarget(bot.provider)
    await mkdir(join(directory, target.directory), { recursive: true, mode: 0o700 })
    await writeFile(join(directory, target.directory, target.file), login.value, { mode: 0o600 })
    return {
      env: { XDG_DATA_HOME: join(directory, ".local/share") },
      release: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
