import { existsSync, statfsSync } from "node:fs"
import { freemem, homedir, release, totalmem } from "node:os"
import { join } from "node:path"
import type { DoctorCheck, MachineCapability } from "@touri/contracts"
import { publicError } from "@touri/contracts"
import type { VmCommandRunner } from "../../vm/command"
import { BOT_IMAGE } from "../../vm/image"
import { containerMemoryChecks } from "../../vm/memory-doctor"
import { DEFAULT_BOT_VM_MEMORY_MB } from "../../vm/resources"

import { machineCapability } from "../macos"

export const vmDoctor = async (
  run: VmCommandRunner,
  dataDir: string,
  capability: MachineCapability = machineCapability(),
): Promise<Array<DoctorCheck>> => {
  if (!capability.available)
    return [{ id: "vm-host", ok: false, detail: capability.reason ?? "VM indisponível", fix: null }]
  const [version, status, image, containers] = await Promise.all([
    run(["--version"]),
    run(["system", "status"]),
    run(["image", "inspect", BOT_IMAGE]),
    run(["list", "--all", "--format", "json"]),
  ])
  const checks: Array<DoctorCheck> = [
    {
      id: "container",
      ok:
        version.code === 0 &&
        (() => {
          const match = version.stdout.match(/version\s+(\d+)\.(\d+)/)
          return Boolean(match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 5)))
        })(),
      detail: version.stdout.trim() || "container indisponível",
      fix: "Instale Apple container >= 1.5.0 no macOS 26",
    },
    {
      id: "vm-system",
      ok: status.code === 0 && Number(release().split(".")[0]) >= 25,
      detail:
        status.code === 0
          ? "Serviço container ativo; macOS 26"
          : `${publicError("MACHINE_SERVICE_UNAVAILABLE").error} [TOURI-E8001]`,
      fix: "container system start",
      ...(status.code !== 0 ? { status: "fail", errorCode: "TOURI-E8001", action: "start-machine-service" } : {}),
    },
    {
      id: "vm-image",
      ok: image.code === 0,
      detail: image.code === 0 ? `${BOT_IMAGE} em cache` : "A imagem será construída no primeiro turno",
      fix: null,
    },
  ]
  const appRoot = join(homedir(), "Library/Application Support/com.apple.container")
  const kernelPresent = existsSync(join(appRoot, "kernels/default.kernel-arm64"))
  checks.push({
    id: "vm-kernel",
    ok: kernelPresent,
    detail: kernelPresent ? "Kernel Linux configurado e presente" : "Kernel padrão ausente",
    fix: "container system kernel set --recommended",
  })
  const fs = statfsSync(dataDir)
  const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3
  const minimumGb = image.code === 0 ? 5 : 12
  checks.push({
    id: "vm-disk",
    ok: freeGb >= minimumGb,
    detail: `${freeGb.toFixed(1)} GiB livres (mínimo ${minimumGb}${image.code === 0 ? "" : " para construir imagem"})`,
    fix: "Libere espaço em disco",
  })
  checks.push({
    id: "vm-ram",
    ok: totalmem() >= 4 * 1024 ** 3 && freemem() >= 2 * 1024 ** 3,
    detail: `${(totalmem() / 1024 ** 3).toFixed(1)} GiB total; ${(freemem() / 1024 ** 3).toFixed(1)} GiB livres; padrão ${DEFAULT_BOT_VM_MEMORY_MB} MiB por VM (configurável)`,
    fix: "Pare máquinas ociosas se houver pressão de memória",
  })
  checks.push(...containerMemoryChecks(containers))
  return checks
}
