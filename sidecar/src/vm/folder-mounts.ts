import { chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join, posix, relative, sep } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { ensurePrivateDirectoryAsync } from "../kernel/async-files"
import {
  canonicalPath,
  excludedBotFolders,
  folderGuestPath,
  resolveBotFolder,
  withinFolder,
} from "../kernel/bot-folders"
import type { VmVolumeSpec } from "./types"

/** Mask denied subtrees in every alias, including the broad /host/home mount. */
export const botFolderMounts = async (kernel: Kernel, bot: Bot, hostHome = homedir()): Promise<VmVolumeSpec[]> => {
  const explicit = (bot.folders ?? []).map((folder) => {
    const path = resolveBotFolder(folder.path)
    if (path !== folder.path) throw new Error("A pasta mudou de destino. Adicione-a novamente nas configurações.")
    return { ...folder, path }
  })
  const roots = [
    ...(bot.anyFolderAccess
      ? [{ path: canonicalPath(hostHome), access: "read-write" as const, target: "/host/home" }]
      : []),
    ...explicit.map((folder) => ({ ...folder, target: folderGuestPath(folder.path) })),
  ]
  if (!roots.length) return []
  const emptyPath = join(kernel.paths.appData, "vm-folder-masks", "empty")
  await ensurePrivateDirectoryAsync({ root: kernel.paths.appData, path: emptyPath })
  const empty = canonicalPath(emptyPath)
  await chmod(empty, 0o555)
  const mounts: VmVolumeSpec[] = []
  const exclusions = excludedBotFolders(kernel.paths.appData, hostHome)
  for (const root of roots) {
    mounts.push({
      type: "bind",
      source: root.path,
      target: root.target,
      readOnly: bot.access === "read-only" || root.access === "read-only",
    })
    const masks = exclusions
      .filter(
        (path) =>
          withinFolder(root.path, path) &&
          !explicit.some((folder) => withinFolder(folder.path, path) && withinFolder(path, folder.path)),
      )
      .filter((path, _, all) => !all.some((other) => other !== path && withinFolder(other, path)))
    for (const path of masks)
      mounts.push({
        type: "bind",
        source: empty,
        target: posix.join(root.target, relative(root.path, path).split(sep).join("/")),
        readOnly: true,
      })
    // A read-only grant cannot be bypassed through a broader writable mount.
    for (const folder of explicit.filter(
      (folder) => folder.access === "read-only" && folder.path !== root.path && withinFolder(root.path, folder.path),
    )) {
      if (masks.some((mask) => withinFolder(mask, folder.path))) continue
      mounts.push({
        type: "bind",
        source: folder.path,
        target: posix.join(root.target, relative(root.path, folder.path).split(sep).join("/")),
        readOnly: true,
      })
    }
  }
  return mounts
}

export const withoutHostFolderMounts = (mounts: VmVolumeSpec[]) =>
  mounts.filter((mount) => mount.target !== "/host" && !mount.target.startsWith("/host/"))
