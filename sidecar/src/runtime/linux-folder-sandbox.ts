import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { canonicalPath, withinFolder } from "../kernel/bot-folders"
import { linuxProtectedFolders, linuxSandboxBase } from "../kernel/folder-capability"
import { resolveMcpSocketPath } from "../kernel/paths"
import { turnFolders, writableTurnFolders } from "./folder-access"

/** Inherited mount namespace: even an approved shell cannot widen these mounts. */
export const linuxFolderSandbox = (
  kernel: Kernel,
  args: StartTurnArgs,
  env: Record<string, string>,
  home = homedir(),
): string[] => {
  const runDir = env.TOURI_RUN_DIR ?? kernel.paths.runDir
  const folders = turnFolders(args)
  const runtime = [
    env.TOURI_MCP_SOCK ?? resolveMcpSocketPath({ ...kernel.paths, runDir }),
    join(runDir, "mcp-tokens", args.thread.id),
    join(runDir, "mcp-shims"),
    ...["mcp.json", "system.md", "settings.json"].map((suffix) =>
      join(runDir, "claude", `${args.thread.id}.${suffix}`),
    ),
    ...[
      env.TMPDIR,
      env.TMP,
      env.TEMP,
      ...(args.bot.provider === "codex" ? [env.CODEX_HOME] : []),
      ...(args.bot.provider === "claude" ? [env.CLAUDE_CONFIG_DIR] : []),
      ...(args.bot.provider === "opencode" ? [env.XDG_DATA_HOME, env.XDG_CONFIG_HOME] : []),
    ].filter((path): path is string => !!path),
    ...(args.bot.provider === "opencode" && env.OPENCODE_CONFIG ? [dirname(env.OPENCODE_CONFIG)] : []),
    ...(args.bot.provider === "codex" && env.CODEX_HOME ? [canonicalPath(join(env.CODEX_HOME, "auth.json"))] : []),
    ...(args.bot.provider === "claude"
      ? [env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), join(home, ".claude.json")]
      : []),
  ]
    .filter(existsSync)
    .map(canonicalPath)
  const workspace = [args.bot.homeDir, args.fingerprint.cwd, env.TOURI_PROJECT_DATA_DIR]
    .filter((path): path is string => !!path)
    .map(canonicalPath)
  const writable = args.bot.access === "read-only" ? runtime : [...runtime, ...workspace, ...writableTurnFolders(args)]
  const explicit = args.bot.folders ?? []
  const executables = [kernel.paths.sidecarBinary, args.mcp?.command]
    .filter((path): path is string => !!path && existsSync(path))
    .map(canonicalPath)
  const internal = [...runtime, ...workspace, ...executables]
  const mounts = [...linuxSandboxBase]
  // Replace the initial root bind before adding the private process/control trees.
  if (
    args.bot.anyFolderAccess &&
    args.bot.access !== "read-only" &&
    !folders.some((folder) => folder.path === "/" && folder.access === "read-only")
  )
    mounts[mounts.indexOf("--ro-bind")] = "--bind"
  const bind = (path: string, write: boolean) => {
    mounts.push(write ? "--bind" : "--ro-bind", path, path)
  }
  for (const path of [...new Set([...internal, ...folders.map((folder) => folder.path)])].sort(
    (a, b) => a.length - b.length,
  )) {
    if (path !== "/" && existsSync(path)) bind(path, writable.includes(path))
  }
  // Explicit RO trees take precedence over broader writable roots.
  for (const folder of folders.filter((folder) => folder.access === "read-only" && folder.path !== "/"))
    bind(folder.path, false)
  // Mask first, then reconstruct only this bot's runtime and explicit exceptions.
  // Sources of subsequent binds are resolved in the host namespace by bwrap.
  const hidden = linuxProtectedFolders(kernel.paths.appData, home).filter(existsSync)
  for (const path of hidden) {
    if (!statSync(path).isDirectory()) continue
    mounts.push("--tmpfs", path)
    const exceptions = [...internal, ...explicit.map((folder) => folder.path)].filter(
      (entry) => withinFolder(path, entry) && existsSync(entry),
    )
    for (const entry of [...new Set(exceptions)].sort((a, b) => a.length - b.length)) {
      const readonly = folders.some((folder) => folder.access === "read-only" && withinFolder(folder.path, entry))
      bind(entry, !readonly && writable.includes(entry))
    }
    mounts.push("--remount-ro", path)
  }
  // A RO home/project grant must not freeze this bot's managed bookkeeping.
  // Only runtime leaves are exempt, never the surrounding application data.
  for (const path of [...new Set(runtime)]) bind(path, true)
  return mounts
}
