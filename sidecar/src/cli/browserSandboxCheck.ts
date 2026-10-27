import { browserSandboxMessage, browserSandboxWarning } from "../browser/sandbox"
import type { DoctorCheck } from "./doctor"
import { type RunCommand, runCommand } from "./tailscale"

export const getBrowserSandboxCheck = async ({
  env = process.env,
  platform = process.platform,
  run = runCommand,
}: {
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  run?: RunCommand
} = {}): Promise<DoctorCheck> => {
  const name = "browser sandbox"
  if (env.TOURI_BROWSER_NO_SANDBOX === "1") return { name, level: "warn", detail: browserSandboxWarning }
  if (platform !== "linux")
    return { name, level: "ok", detail: "A verificação de namespaces Linux não se aplica a este sistema." }

  const result = await run("unshare", ["--user", "--map-root-user", "--net", "true"])
  if (result.code === 127)
    return { name, level: "warn", detail: "Instale util-linux para verificar os namespaces do navegador." }
  if (result.code !== 0) return { name, level: "warn", detail: browserSandboxMessage }

  return {
    name,
    level: "ok",
    detail: "Namespaces de usuário e rede disponíveis; a proteção do navegador permanece ativa.",
  }
}
