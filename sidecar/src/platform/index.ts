import type { MachineCapability } from "@touri/contracts"
import * as linux from "./linux"
import * as macos from "./macos"
import type { OciEngine } from "./oci-provider"
import * as windows from "./windows"
export const platformFor = (platform: string) =>
  platform === "darwin" ? macos : platform === "win32" ? windows : linux
export const hostPlatform = platformFor(process.platform)
export const hostComputerSupported = process.platform === "darwin"
export const ociEngine = (
  platform = process.platform,
  which: (name: string) => string | null = Bun.which,
): OciEngine | null => {
  if (platform === "linux" && which("podman")) return "podman"
  return (platform === "linux" || platform === "win32") && which("docker") ? "docker" : null
}
export const machineCapability = (): MachineCapability => {
  if (process.platform === "darwin") return macos.machineCapability()
  if (process.env.TOURI_HEADLESS === "1")
    return { available: false, reason: "sem virtualização neste host", provider: null }
  const engine = ociEngine()
  return engine
    ? { available: true, provider: engine, reason: null }
    : {
        available: false,
        provider: null,
        reason:
          process.platform === "win32"
            ? "Docker Desktop with the WSL2 Linux engine is unavailable. Use local bots or start Docker Desktop."
            : "Podman/Docker unavailable. Use local bots or install a container engine.",
      }
}
