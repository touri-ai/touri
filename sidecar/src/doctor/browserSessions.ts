import type { Database } from "bun:sqlite"
import type { DoctorCheck, Kernel } from "@touri/contracts"
import { browserSessionKeyAccount, hasBotSession, loadBotSession, SessionVaultError } from "../browser/sessionVault"
import { SERVER_VAULT_GUIDANCE } from "../vm/provider-login"
import { check } from "./check"
import type { LocalProbes } from "./local"

/** Check saved sessions without logging, returning, or rewriting their contents. */
export const browserSessionChecks = async (
  kernel: Kernel,
  signal: AbortSignal,
  host: Pick<LocalProbes, "platform" | "headless">,
): Promise<DoctorCheck[]> => {
  const bots = (kernel.db as Database).query("SELECT id, name FROM bots WHERE archived_at IS NULL").all() as {
    id: string
    name: string
  }[]
  const checks: DoctorCheck[] = []
  for (const bot of bots) {
    signal.throwIfAborted()
    const id = `browser-session:${bot.id}`
    const label = `Navegador · ${bot.name} · sessão salva`
    try {
      if (!hasBotSession(kernel, bot.id)) continue
      await loadBotSession(kernel, bot.id)
      checks.push(check(id, label, "pass", "Sessão salva do navegador disponível."))
    } catch (error) {
      signal.throwIfAborted()
      if (host.platform !== "darwin" || host.headless) {
        checks.push(check(id, label, "fail", SERVER_VAULT_GUIDANCE))
        continue
      }
      const recoverable =
        error instanceof SessionVaultError &&
        [
          "VAULT_ACCESS_REQUIRED",
          "VAULT_TIMEOUT",
          "VAULT_CANCELLED",
          "VAULT_UNAVAILABLE",
          "HOST_UNAVAILABLE",
          "HOST_ERROR",
        ].includes(error.errorCode)
      checks.push({
        ...check(
          id,
          label,
          "fail",
          recoverable
            ? "Permita o acesso ao cofre para restaurar a sessão salva do navegador."
            : "Não foi possível ler a sessão salva do navegador. Os dados salvos foram mantidos. Verifique o cofre e tente novamente.",
        ),
        ...(recoverable ? { action: "authorize-vault" as const, vaultAccount: browserSessionKeyAccount(bot.id) } : {}),
      })
    }
  }
  return checks
}
