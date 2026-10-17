import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import {
  canonicalPath,
  excludedBotFolders,
  folderGuestPath,
  resolveBotFolder,
  withinFolder,
} from "../kernel/bot-folders"

export const turnFolders = (args: StartTurnArgs) => {
  const folders = (args.bot.folders ?? []).map((folder) => {
    if (args.execution) return { ...folder, path: folderGuestPath(folder.path) }
    const path = resolveBotFolder(folder.path)
    if (path !== folder.path) throw new Error("A pasta mudou de destino. Adicione-a novamente nas configurações.")
    return { ...folder, path }
  })
  if (args.bot.anyFolderAccess) folders.unshift({ path: args.execution ? "/host/home" : "/", access: "read-write" })
  return folders
}

export const writableTurnFolders = (args: StartTurnArgs): string[] =>
  args.bot.access === "read-only"
    ? []
    : turnFolders(args)
        .filter((folder) => folder.access === "read-write")
        .map((folder) => folder.path)

const subpath = (path: string) => `(subpath ${JSON.stringify(canonicalPath(path))})`
const except = (paths: string[]) => paths.map((path) => `(require-not ${subpath(path)})`).join(" ")

/** Outer, inherited Seatbelt policy also covers Bash and provider approval bypasses. */
export const localFolderProfile = (
  kernel: Kernel,
  args: StartTurnArgs,
  env: Record<string, string>,
  home = homedir(),
): string => {
  const folders = turnFolders(args)
  const explicit = args.bot.folders ?? []
  // Provider bookkeeping must remain writable even for a read-only conversation.
  const runDir = env.TOURI_RUN_DIR ?? kernel.paths.runDir
  const runtimePaths = [
    join(runDir, "mcp.sock"),
    join(runDir, "mcp-tokens", args.thread.id),
    join(runDir, "mcp-shims"),
    ...["mcp.json", "system.md", "settings.json"].map((suffix) =>
      join(runDir, "claude", `${args.thread.id}.${suffix}`),
    ),
    ...(env.OPENCODE_CONFIG ? [dirname(env.OPENCODE_CONFIG)] : []),
    ...[env.CODEX_HOME, env.CLAUDE_CONFIG_DIR, env.XDG_DATA_HOME].filter((path): path is string => !!path),
    // The managed Codex home's auth link must remain writable for shared token refreshes.
    ...(args.bot.provider === "codex" &&
    env.CODEX_HOME &&
    canonicalPath(join(env.CODEX_HOME, "auth.json")) === canonicalPath(join(home, ".codex/auth.json"))
      ? [canonicalPath(join(env.CODEX_HOME, "auth.json"))]
      : []),
  ]
  const state = [
    ...runtimePaths,
    env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
    join(home, ".claude.json"),
    join(home, ".claude.json.lock"),
    env.CODEX_HOME ?? join(home, ".codex"),
    join(args.bot.homeDir, ".touri-opencode"),
    join(home, ".cache"),
    tmpdir(),
  ]
  const workspace = [args.bot.homeDir, args.fingerprint.cwd, env.TOURI_PROJECT_DATA_DIR].filter(
    (path): path is string => !!path,
  )
  const writes =
    args.bot.access === "read-only"
      ? state
      : [...state, ...workspace, ...(args.bot.anyFolderAccess ? ["/"] : writableTurnFolders(args))]
  const rules = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writes.map(subpath).join(" ")} ${["/dev/null", "/dev/zero", "/dev/tty", "/dev/stdout", "/dev/stderr"].map((path) => `(literal ${JSON.stringify(path)})`).join(" ")} (subpath "/dev/fd"))`,
  ]
  // Explicit read-only trees win even when nested in a writable root or /.
  for (const folder of folders.filter((folder) => folder.access === "read-only"))
    rules.push(`(deny file-write* ${subpath(folder.path)})`)
  for (const denied of new Set(excludedBotFolders(kernel.paths.appData, home).map(canonicalPath))) {
    const overrides = explicit.filter((folder) => withinFolder(denied, folder.path)).map((folder) => folder.path)
    // Only this bot's runtime files are exempted from the application data deny.
    const internal = [args.bot.homeDir, ...runtimePaths, env.TOURI_PROJECT_DATA_DIR].filter(
      (path): path is string => !!path && withinFolder(denied, canonicalPath(path)),
    )
    const exemptions = [...overrides, ...internal]
    if (denied === canonicalPath(kernel.paths.appData)) {
      // Runtime loaders inspect ancestor directories (e.g. Bun's env loader).
      // Permit those directories themselves, never their other files or writes.
      const ancestors = new Set<string>()
      for (const path of internal) {
        let parent = dirname(canonicalPath(path))
        while (withinFolder(denied, parent)) {
          ancestors.add(parent)
          if (parent === denied) break
          parent = dirname(parent)
        }
      }
      const traversal = [...ancestors].map((path) => `(require-not (literal ${JSON.stringify(path)}))`).join(" ")
      rules.push(`(deny file-read* (require-all ${subpath(denied)} ${except(exemptions)} ${traversal}))`)
      rules.push(`(deny file-write* (require-all ${subpath(denied)} ${except(exemptions)}))`)
    } else {
      rules.push(`(deny file-read* file-write* (require-all ${subpath(denied)} ${except(exemptions)}))`)
    }
  }
  // Full provider access never makes read-only folder grants writable.
  return rules.join("\n")
}

export const spawnFolderProvider = (
  kernel: Kernel,
  args: StartTurnArgs,
  input: Parameters<Kernel["spawnTree"]>[0],
): ReturnType<Kernel["spawnTree"]> => {
  if (args.execution) return args.execution.spawn(input)
  // Do not silently drop the security boundary on a host without Seatbelt.
  if (process.platform !== "darwin" && !args.bot.anyFolderAccess && !args.bot.folders?.length)
    return kernel.spawnTree(input)
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    return { success: false, errorCode: "SPAWN_FAILED", error: "O acesso a pastas requer o sandbox do macOS." }
  return kernel.spawnTree({
    ...input,
    cmd: "/usr/bin/sandbox-exec",
    args: ["-p", localFolderProfile(kernel, args, input.env), input.cmd, ...input.args],
  })
}
