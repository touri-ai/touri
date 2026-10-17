import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { canonicalPath, excludedBotFolders, folderGuestPath, withinFolder } from "../kernel/bot-folders"
import { TouriError } from "../kernel/errors"

export class WorkspacePathError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? "Arquivo ou pasta não encontrado"
        : status === 403
          ? "Acesso a esta pasta não autorizado"
          : "Caminho inválido",
    )
  }
}

const validate = (path: string) => {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new WorkspacePathError(400)
  }
  if (path.length > 4096 || [path, decoded].some((value) => /[\\\0]/.test(value) || value.split("/").includes("..")))
    throw new WorkspacePathError(400)
}

/** Resolve grants for file and image readers; reads still use pinned, no-follow descriptors. */
export const workspacePath = (kernel: Kernel, bot: Bot, path: string, base = "") => {
  validate(path)
  validate(base)
  const guest = bot.machine === "vm" || bot.machine === "cloud"
  const project =
    !guest && bot.projectId
      ? ((kernel.db as import("bun:sqlite").Database)
          .query("SELECT path FROM projects WHERE id = ? AND archived_at IS NULL")
          .get(bot.projectId) as { path: string } | null)
      : null
  const cwd = guest ? "/workspace" : bot.cwd || project?.path || bot.homeDir
  const candidate = resolve(cwd, base, path)
  const explicit = bot.machine === "cloud" ? [] : (bot.folders ?? [])
  const roots = guest
    ? [
        { source: "/workspace", target: "/workspace", explicit: false },
        ...explicit.flatMap((folder) => [
          { source: folder.path, target: folderGuestPath(folder.path), explicit: true },
          { source: folderGuestPath(folder.path), target: folderGuestPath(folder.path), explicit: false },
        ]),
        ...(bot.machine === "vm" && bot.anyFolderAccess
          ? [{ source: "/host/home", target: "/host/home", explicit: false }]
          : []),
      ]
    : [
        ...[bot.homeDir, bot.cwd, project?.path]
          .filter((value): value is string => !!value)
          .map((source) => ({ source, target: source, explicit: false })),
        ...explicit.map((folder) => ({ source: folder.path, target: folder.path, explicit: true })),
        ...(bot.anyFolderAccess ? [{ source: "/", target: "/", explicit: false }] : []),
      ]
  const grant = roots
    .flatMap((root) => (guest ? [root] : [root, { ...root, source: canonicalPath(root.source) }]))
    .sort((a, b) => b.source.length - a.source.length)
    .find((root) => withinFolder(root.source, candidate))
  if (!grant) throw new WorkspacePathError(403)
  const suffix = relative(grant.source, candidate)
  if (guest) return { root: grant.target, path: suffix }

  const exclusions = excludedBotFolders(kernel.paths.appData)
  const permitted = [bot.homeDir, ...explicit.map((folder) => folder.path)].flatMap((root) => [
    root,
    canonicalPath(root),
  ])
  const denied = (candidate: string) =>
    exclusions.some(
      (excluded) =>
        withinFolder(excluded, candidate) &&
        !permitted.some((root) => withinFolder(excluded, root) && withinFolder(root, candidate)),
    )
  if (denied(candidate)) throw new WorkspacePathError(403)
  // With access to any folder, system links such as /var -> /private/var are not escapes:
  // walk from the canonical parent. Granted folders keep refusing links below their root.
  if (grant.target === "/" && !grant.explicit) {
    const parent = realpathSync(dirname(candidate))
    if (denied(join(parent, basename(candidate)))) throw new WorkspacePathError(403)
    const leaf = join(parent, basename(candidate))
    if (leaf !== parent && lstatSync(leaf).isSymbolicLink()) throw new WorkspacePathError(403)
    return { root: parent, path: basename(candidate) }
  }
  if (lstatSync(grant.target).isSymbolicLink()) throw new WorkspacePathError(403)
  const root = realpathSync(grant.target)
  if (grant.explicit && root !== resolve(grant.target)) throw new WorkspacePathError(403)
  if (denied(join(root, suffix))) throw new WorkspacePathError(403)
  let current = root
  for (const part of suffix.split("/").filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new WorkspacePathError(403)
  }
  return { root, path: suffix }
}

export const workspaceError = (error: unknown): { status: number; json: { error: string } } => {
  if (error instanceof WorkspacePathError) return { status: error.status, json: { error: error.message } }
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "ENOENT") return { status: 404, json: { error: "Arquivo ou pasta não encontrado" } }
  if (["EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(code ?? "") || error instanceof TouriError)
    return { status: 403, json: { error: "Acesso a esta pasta não autorizado" } }
  return { status: 422, json: { error: "Arquivo inválido ou acima do limite de tamanho" } }
}

// The same guest paths used by folder mounts are also accepted by the read endpoints.
export const guestFileErrors = (source: string): string => `import errno,json,sys
try:
${source
  .split("\n")
  .map((line) => ` ${line}`)
  .join("\n")}
except OSError as e:
 print(json.dumps(dict(errorStatus=404 if e.errno==errno.ENOENT else 403)))
 sys.exit(1)`

export const checkGuestFileError = (stdout: string) => {
  const result = JSON.parse(stdout) as { errorStatus?: number }
  if (result.errorStatus === 403 || result.errorStatus === 404) throw new WorkspacePathError(result.errorStatus)
}
