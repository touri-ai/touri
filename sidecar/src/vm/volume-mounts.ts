import { realpathSync } from "node:fs"
import { isAbsolute, resolve, win32 } from "node:path"
import type { VmVolumeSpec } from "./types"

/** Revalidate host grants immediately before passing mounts to a container engine. */
export const validatedVolumeMounts = (
  mounts: VmVolumeSpec[] = [],
  { platform = process.platform, managedOnly = false }: { platform?: string; managedOnly?: boolean } = {},
): VmVolumeSpec[] =>
  mounts.map((mount) => {
    if (
      !mount.target.startsWith("/") ||
      mount.target.split("/").includes("..") ||
      /[\0\n\r,]/.test(mount.target) ||
      /[\0\n\r,]/.test(mount.source)
    )
      throw new Error("Invalid volume path")
    if (mount.type === "volume") return mount
    if (!(platform === "win32" ? win32.isAbsolute(mount.source) : isAbsolute(mount.source)))
      throw new Error("Bind source must be absolute")
    const managed = mount.target === "/host" || mount.target.startsWith("/host/")
    // OCI can also mount engine-visible paths; host grants always require a local recheck.
    if (managedOnly && !managed) return mount
    const source = realpathSync(mount.source)
    // Managed grants are canonical; only macOS system path aliases may differ.
    const expected =
      platform === "darwin"
        ? resolve(mount.source).replace(/^\/(var|tmp|etc)(?=\/|$)/, "/private/$1")
        : resolve(mount.source)
    if (managed && source !== expected) throw new Error("Host folder changed after validation")
    return { ...mount, source }
  })
