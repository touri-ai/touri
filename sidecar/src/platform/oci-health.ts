import type { VmCommandOutput, VmCommandRunner } from "../vm/command"
import type { OciEngine } from "./oci-provider"

export const WINDOWS_VM_FIX =
  "Start Docker Desktop, enable its WSL2 backend and switch to Linux containers. Local bots remain available."
const localDesktopPipe = (value: unknown): boolean =>
  typeof value === "string" && /^npipe:\/\/\/\/\.\/pipe\/(dockerDesktopLinuxEngine|docker_engine)$/i.test(value)

/** A Windows host must not accidentally select a remote daemon or Windows containers. */
export const probeOciService = async ({
  engine,
  platform = process.platform,
  run,
  dockerHost = process.env.DOCKER_HOST,
}: {
  engine: OciEngine
  platform?: string
  run: VmCommandRunner
  dockerHost?: string
}): Promise<VmCommandOutput> => {
  const info = await run(["info", "--format", "{{json .}}"], { timeoutMs: 1500 })
  if (platform !== "win32") return info
  const unavailable = (): VmCommandOutput => ({ code: 1, stdout: "", stderr: WINDOWS_VM_FIX })
  if (engine !== "docker" || info.code !== 0 || (dockerHost && !localDesktopPipe(dockerHost))) return unavailable()
  try {
    const data = JSON.parse(info.stdout)
    if (
      data.OSType !== "linux" ||
      !/docker desktop/i.test(data.OperatingSystem ?? "") ||
      !/wsl2/i.test(data.KernelVersion ?? "")
    )
      return unavailable()
    if (!dockerHost) {
      const context = await run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {
        timeoutMs: 1500,
      })
      if (context.code !== 0 || !localDesktopPipe(JSON.parse(context.stdout))) return unavailable()
    }
    return info
  } catch {
    return unavailable()
  }
}
