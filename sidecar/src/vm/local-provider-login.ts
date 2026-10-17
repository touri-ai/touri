import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { prepareHostCodexHome } from "../runtime/codex/home"
import { loginTarget, readProviderLogin, redactProviderLogin, storedProviderLoginSource } from "./provider-login"

/** Prepare a persistent host-login home or temporary vault credentials for a local CLI turn. */
export const prepareLocalProviderLogin = async (
  kernel: Kernel,
  bot: Bot,
  signal: AbortSignal,
  hostHome = homedir(),
) => {
  signal.throwIfAborted()
  if (storedProviderLoginSource(kernel, bot) !== "vault") {
    if (bot.provider === "codex" && bot.machine === "local" && !bot.providerProfile)
      return { env: { CODEX_HOME: prepareHostCodexHome(kernel.paths.appData, bot.id, hostHome) }, release: () => {} }
    return { env: {}, release: () => {} }
  }
  const login = await readProviderLogin(kernel, bot, hostHome, { signal })
  redactProviderLogin(kernel, login.value)
  if (bot.provider === "claude") return { env: { CLAUDE_CODE_OAUTH_TOKEN: login.value }, release: () => {} }
  const directory = mkdtempSync(join(kernel.paths.runDir, "provider-turn-"))
  chmodSync(directory, 0o700)
  try {
    const target = loginTarget(bot.provider)
    mkdirSync(join(directory, target.directory), { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, target.directory, target.file), login.value, { mode: 0o600 })
    return {
      env:
        bot.provider === "codex"
          ? { CODEX_HOME: join(directory, ".codex") }
          : { XDG_DATA_HOME: join(directory, ".local/share") },
      release: () => rmSync(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
