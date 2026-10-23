import type { Bot, BotCapability, Kernel } from "@touri/contracts"
import { machineCapability } from "../platform"

export const capabilitySupport = (
  kernel: Kernel,
  bot: Bot,
  capability: BotCapability,
  {
    platform = process.platform,
    env = process.env,
    which = Bun.which,
    machineAvailable = () => machineCapability().available,
  } = {},
): string | null => {
  if (bot.machine === "cloud") return "Este recurso não está disponível para bots na nuvem."
  const isolated = bot.machine === "vm" && (capability === "browser" || !bot.hostComputerUse)
  if (isolated)
    return kernel.services.use("vm.runtime") && machineAvailable()
      ? null
      : "O computador isolado não está disponível neste servidor."
  if (capability === "computer_use")
    return platform === "darwin" && env.TOURI_HEADLESS !== "1"
      ? null
      : "O controle da tela deste computador não é suportado nesta plataforma."
  if (platform === "darwin") return null // The isolated browser can be installed after consent.
  const executable = env.TOURI_CHROME_BIN
    ? which(env.TOURI_CHROME_BIN)
    : which("chromium") || which("chromium-browser") || which("google-chrome")
  if (!executable) return "O navegador não está instalado neste servidor. Peça à pessoa responsável para instalá-lo."
  return null
}
