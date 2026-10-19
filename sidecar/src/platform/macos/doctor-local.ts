import { join } from "node:path"
import type { DoctorCheck, Kernel } from "@touri/contracts"
import { publicError } from "@touri/contracts"
import { check, shellQuote } from "../../doctor/check"
import type { DoctorCommand } from "../../doctor/command"
import type { LocalProbes } from "../../doctor/local"
import { BOT_IMAGE } from "../../vm/image"
import { containerMemoryChecks } from "../../vm/memory-doctor"
export const appleContainerChecks = async (
  kernel: Kernel,
  path: string | null,
  run: DoctorCommand,
  signal: AbortSignal,
  probes: LocalProbes,
): Promise<DoctorCheck[]> => {
  const hostReady =
    probes.platform === "darwin" &&
    probes.arch === "arm64" &&
    Number(probes.osRelease.split(".")[0]) >= 25 &&
    !probes.headless
  if (!hostReady || !path) {
    const detail = !hostReady
      ? "Máquinas isoladas exigem Apple Silicon e macOS 26 no aplicativo desktop. Bots locais continuam disponíveis."
      : "Apple container não encontrado no PATH. Instale-o para usar máquinas isoladas."
    const fix = !hostReady ? "softwareupdate --list" : "brew install container"
    return [
      check("container", "Apple container · versão", "warn", detail, fix),
      check(
        "vm-system",
        "Apple container · serviço",
        "warn",
        "Serviço não verificado: resolva o requisito de Apple container primeiro.",
        fix,
      ),
      check(
        "vm-image",
        "Máquinas · imagem",
        "warn",
        `${BOT_IMAGE} não verificada: resolva o requisito de Apple container primeiro.`,
        fix,
      ),
    ]
  }
  const [version, service, image, containers] = await Promise.all([
    run(path, ["--version"], signal),
    run(path, ["system", "status"], signal),
    run(path, ["image", "inspect", BOT_IMAGE], signal),
    run(path, ["list", "--all", "--format", "json"], signal),
  ])
  const number = version.stdout.match(/\b(\d+)\.(\d+)(?:\.(\d+))?\b/)
  const supported =
    version.code === 0 &&
    !version.timedOut &&
    Boolean(number && (Number(number[1]) > 1 || (Number(number[1]) === 1 && Number(number[2]) >= 5)))
  const serviceReady = service.code === 0 && !service.timedOut
  const imageReady = image.code === 0 && !image.timedOut
  const checks = [
    check(
      "container",
      "Apple container · versão",
      supported ? "pass" : "warn",
      supported
        ? `Apple container ${number?.[0]} disponível.`
        : "Apple container 1.5.0 ou mais recente é necessário; a versão não foi confirmada ou está desatualizada.",
      "brew upgrade container",
    ),
    {
      ...check(
        "vm-system",
        "Apple container · serviço",
        serviceReady ? "pass" : "fail",
        serviceReady
          ? "Serviço de virtualização ativo."
          : `${publicError("MACHINE_SERVICE_UNAVAILABLE").error} [TOURI-E8001]`,
        "container system start",
      ),
      ...(!serviceReady ? { errorCode: "TOURI-E8001", action: "start-machine-service" as const } : {}),
    },
  ]
  if (imageReady) checks.push(check("vm-image", "Máquinas · imagem", "pass", `${BOT_IMAGE} presente no cache local.`))
  else if (!serviceReady || image.timedOut)
    checks.push(
      check(
        "vm-image",
        "Máquinas · imagem",
        "warn",
        "A presença da imagem não pôde ser confirmada. Inicie o serviço e execute o diagnóstico novamente.",
        "container system start",
      ),
    )
  else {
    try {
      const context = await probes.prepareImage(kernel.paths.appData)
      checks.push(
        check(
          "vm-image",
          "Máquinas · imagem",
          "warn",
          `${BOT_IMAGE} ausente. O primeiro turno constrói a imagem; para antecipar, execute o comando abaixo.`,
          `container build --tag ${shellQuote(BOT_IMAGE)} --file ${shellQuote(join(context, "Containerfile"))} ${shellQuote(context)}`,
        ),
      )
    } catch {
      checks.push(
        check(
          "vm-image",
          "Máquinas · imagem",
          "fail",
          "Imagem ausente e não foi possível preparar os arquivos de construção. Verifique o espaço e as permissões da pasta de dados.",
          `ls -ld ${shellQuote(kernel.paths.appData)}`,
        ),
      )
    }
  }
  // Keep the VM prerequisites that the previous diagnostic already exposed.
  try {
    const present = probes.kernelPresent()
    checks.push(
      check(
        "vm-kernel",
        "Máquinas · kernel Linux",
        present ? "pass" : "warn",
        present
          ? "Kernel Linux padrão presente."
          : "Kernel Linux padrão ausente. Configure-o antes de iniciar uma máquina.",
        "container system kernel set --recommended",
      ),
    )
  } catch {
    checks.push(
      check(
        "vm-kernel",
        "Máquinas · kernel Linux",
        "warn",
        "Não foi possível verificar o kernel Linux padrão.",
        "container system status",
      ),
    )
  }
  try {
    const memory = probes.memory()
    const ready = memory.total >= 4 * 1024 ** 3 && memory.free >= 2 * 1024 ** 3
    checks.push(
      check(
        "vm-ram",
        "Máquinas · memória",
        ready ? "pass" : "warn",
        `${(memory.total / 1024 ** 3).toFixed(1)} GiB de RAM total; ${(memory.free / 1024 ** 3).toFixed(1)} GiB livres. Recomendados 4 GiB no Mac e 2 GiB livres para iniciar uma máquina.`,
        "open -a 'Activity Monitor'",
      ),
    )
  } catch {
    checks.push(
      check(
        "vm-ram",
        "Máquinas · memória",
        "warn",
        "Não foi possível consultar a memória disponível.",
        "open -a 'Activity Monitor'",
      ),
    )
  }
  checks.push(...containerMemoryChecks(containers))
  return checks
}
