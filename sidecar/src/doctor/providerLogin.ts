import type { Database } from "bun:sqlite"
import type { Bot, DoctorCheck, Kernel } from "@touri/contracts"
import {
  loginTarget,
  ProviderLoginError,
  providerLoginAccount,
  readHostLoginFile,
  readVault,
  storedProviderLoginSource,
  VAULT_READ_DEADLINE_MS,
  validLogin,
} from "../vm/provider-login"
import { check } from "./check"

const SETTINGS_PATH = "Permissões do bot > Computador > Login do provedor"

type VmBotRow = { id: string; name: string; provider: Bot["provider"] }

const vmBots = (kernel: Kernel): Array<VmBotRow> => {
  try {
    return (
      ((kernel.db as Database | undefined)
        ?.query(
          "SELECT id, name, provider FROM bots WHERE machine = 'vm' AND vm_provider_login = 1 AND archived_at IS NULL",
        )
        .all() as Array<VmBotRow> | undefined) ?? []
    )
  } catch {
    return []
  }
}

const vaultCheck = async (kernel: Kernel, bot: VmBotRow, signal: AbortSignal, label: string): Promise<DoctorCheck> => {
  const id = `provider-login:${bot.id}`
  const target = loginTarget(bot.provider)
  try {
    const entry = await readVault(kernel, bot, target, { signal, timeoutMs: VAULT_READ_DEADLINE_MS })
    if (entry && validLogin(bot.provider, entry))
      return check(id, label, "pass", `${bot.name}: login do ${target.label} salvo no cofre.`)
    if (entry)
      return check(
        id,
        label,
        "fail",
        `${bot.name}: login do ${target.label} inválido. Conecte novamente.`,
        target.command,
      )
    return check(
      id,
      label,
      "warn",
      `${bot.name}: nenhum login do ${target.label} no cofre. Abra ${SETTINGS_PATH}.`,
      target.command,
    )
  } catch (error) {
    signal.throwIfAborted()
    const detail = error instanceof ProviderLoginError ? error.message : "O cofre de segredos não respondeu."
    return {
      ...check(id, label, "fail", `${bot.name}: ${detail}`, target.command),
      action: "authorize-vault",
      vaultAccount: providerLoginAccount(bot.id, bot.provider),
    }
  }
}

const botCheck = async (kernel: Kernel, bot: VmBotRow, hostHome: string, signal: AbortSignal): Promise<DoctorCheck> => {
  const id = `provider-login:${bot.id}`
  const target = loginTarget(bot.provider)
  const source = storedProviderLoginSource(kernel, bot)
  if (source === "host-file") {
    let present = false
    try {
      present = validLogin(bot.provider, readHostLoginFile(hostHome, target), true)
    } catch {}
    const label = `Login · ${bot.name} · arquivo do host`
    return present
      ? check(id, label, "pass", `${bot.name}: usa o arquivo de login do ${target.label} neste Mac.`)
      : check(id, label, "fail", `${bot.name}: arquivo de login do ${target.label} ausente neste Mac.`, target.command)
  }
  if (source === "vault") return vaultCheck(kernel, bot, signal, `Login · ${bot.name} · cofre`)
  return check(
    id,
    `Login · ${bot.name} · fonte pendente`,
    "warn",
    `${bot.name}: a fonte do login será definida no próximo turno. Ou escolha em ${SETTINGS_PATH}.`,
  )
}

/** Per-bot provider login source and health for VM bots; never persists or changes a source. */
export const providerLoginChecks = async (
  kernel: Kernel,
  hostHome: string,
  signal: AbortSignal,
): Promise<Array<DoctorCheck>> => Promise.all(vmBots(kernel).map((bot) => botCheck(kernel, bot, hostHome, signal)))
