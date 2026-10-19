import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { canonicalPath, withinFolder } from "../kernel/bot-folders"
import { linuxProtectedFolders, linuxSandboxBase, specificFoldersRequired } from "../kernel/folder-capability"
import { resolveMcpSocketPath } from "../kernel/paths"
import { linuxRuntimeEnvironment } from "../platform/linux-environment"
import { linuxProgramFiles, linuxProgramLinks } from "../platform/linux-programs"
import { claudeFileEnvironment, claudeLinuxAuthentication } from "./claude/linux-auth"
import { codexAuthenticationKeys } from "./codex/home"
import { turnFolders } from "./folder-access"

const privateTemp = (env: Record<string, string>, runDir: string): string =>
  env.TMPDIR && withinFolder(join(runDir, "provider-tmp"), canonicalPath(env.TMPDIR)) ? env.TMPDIR : "/tmp"

const loginUnavailable =
  "Não foi possível acessar o login do bot com segurança. Entre novamente na conta nas configurações."

// A writable login link must never turn into a mount of the DB, another bot's
// credentials, or arbitrary host files on the next turn.
const credential = (path: string, roots: string[]): string | undefined => {
  if (!existsSync(path)) return undefined
  const real = canonicalPath(path)
  if (!statSync(real).isFile() || !roots.some((root) => withinFolder(root, real))) throw new Error(loginUnavailable)
  return real
}

/** Keep unrelated host credentials and loader/shell injection out of the CLI and its tools. */
export const linuxFolderEnvironment = (args: StartTurnArgs, env: Record<string, string>): Record<string, string> => {
  const common = [
    "TOURI_APP_DATA",
    "TOURI_RUN_DIR",
    "TOURI_MCP_SOCK",
    "TOURI_PROJECT_DATA_DIR",
    "DISABLE_TELEMETRY",
    "DISABLE_ERROR_REPORTING",
    "DO_NOT_TRACK",
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
  ]
  const provider = {
    codex: [
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      ...(args.bot.provider === "codex" ? codexAuthenticationKeys(env.CODEX_HOME) : []),
    ],
    claude: [
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      ...(env.CLAUDE_CODE_USE_BEDROCK === "1"
        ? [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_PROFILE",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_BEARER_TOKEN_BEDROCK",
            "ANTHROPIC_BEDROCK_BASE_URL",
          ]
        : []),
      ...(env.CLAUDE_CODE_USE_VERTEX === "1"
        ? ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS"]
        : []),
      ...(env.CLAUDE_CODE_USE_FOUNDRY === "1"
        ? ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_FOUNDRY_BASE_URL"]
        : []),
    ],
    opencode: [
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_TEST_HOME",
      "OPENCODE_TEST_MANAGED_CONFIG_DIR",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_PURE",
      "OPENCODE_DISABLE_MODELS_FETCH",
      "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
      "OPENCODE_SERVER_PASSWORD",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "MISTRAL_API_KEY",
      "GROQ_API_KEY",
      "XAI_API_KEY",
    ],
  }[args.bot.provider]
  return {
    ...linuxRuntimeEnvironment(env, [...common, ...provider]),
    TMPDIR: privateTemp(env, env.TOURI_RUN_DIR ?? "/touri/run"),
    TMP: privateTemp(env, env.TOURI_RUN_DIR ?? "/touri/run"),
    TEMP: privateTemp(env, env.TOURI_RUN_DIR ?? "/touri/run"),
    ...Object.fromEntries(
      provider
        .filter((key) => ["CODEX_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"].includes(key) && env[key] !== undefined)
        .map((key) => [key, env[key]]),
    ),
    ...(args.bot.provider === "claude" ? { CLAUDE_CONFIG_DIR: join(args.bot.homeDir, ".touri-claude") } : {}),
    ...(args.bot.provider === "claude" ? claudeFileEnvironment(env) : {}),
    TOURI_PID_NAMESPACE: "1",
  }
}

/** Inherited allowlist: tools can only reach these mounts, regardless of CLI approvals. */
export const linuxFolderSandbox = (
  kernel: Kernel,
  args: StartTurnArgs,
  env: Record<string, string>,
  home = homedir(),
  command?: string,
): string[] => {
  if (args.bot.anyFolderAccess || args.bot.folders?.some((folder) => folder.path === "/"))
    throw new Error(specificFoldersRequired)
  // Re-resolve grants immediately before binding; a changed realpath fails closed.
  const folders = turnFolders(args)
  const claudeHome = join(args.bot.homeDir, ".touri-claude")
  const hostCodex = join(canonicalPath(home), ".codex")
  const hostCodexAuth = canonicalPath(join(hostCodex, "auth.json"))
  const codexAuth = args.bot.provider === "codex" && env.CODEX_HOME ? join(env.CODEX_HOME, "auth.json") : undefined
  const codexCredential = codexAuth
    ? credential(codexAuth, [
        canonicalPath(env.CODEX_HOME ?? ""),
        // The shared login is one file, never the host's history/config directory.
        ...(canonicalPath(hostCodex) === hostCodex && withinFolder(hostCodex, hostCodexAuth) ? [hostCodexAuth] : []),
      ])
    : undefined
  const codexAlias =
    codexAuth && codexCredential && lstatSync(codexAuth).isSymbolicLink()
      ? resolve(dirname(codexAuth), readlinkSync(codexAuth))
      : undefined
  const claudeSource = env.CLAUDE_CONFIG_DIR ?? join(canonicalPath(home), ".claude")
  const claudeCredential =
    args.bot.provider === "claude" &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    !env.ANTHROPIC_API_KEY &&
    !env.ANTHROPIC_AUTH_TOKEN &&
    ![env.CLAUDE_CODE_USE_BEDROCK, env.CLAUDE_CODE_USE_VERTEX, env.CLAUDE_CODE_USE_FOUNDRY].includes("1")
      ? credential(
          join(claudeSource, ".credentials.json"),
          canonicalPath(claudeSource) === resolve(claudeSource) ? [canonicalPath(claudeSource)] : [],
        )
      : undefined
  const runDir = env.TOURI_RUN_DIR ?? kernel.paths.runDir
  const authentication =
    args.bot.provider === "claude"
      ? claudeLinuxAuthentication({
          env,
          appData: kernel.paths.appData,
          home,
          source: claudeSource,
          settings: join(runDir, "claude", `${args.thread.id}.settings.json`),
          cwd: args.fingerprint.cwd,
        })
      : { files: [], executables: [] }
  const readonly = [
    ...authentication.files,
    env.TOURI_MCP_SOCK ?? resolveMcpSocketPath({ ...kernel.paths, runDir }),
    join(runDir, "mcp-tokens", args.thread.id),
    ...["mcp.json", "system.md", "settings.json"].map((suffix) =>
      join(runDir, "claude", `${args.thread.id}.${suffix}`),
    ),
  ]
  const state = [
    ...(privateTemp(env, runDir) === "/tmp" ? [] : [privateTemp(env, runDir)]),
    ...(args.bot.provider === "codex" ? [env.CODEX_HOME] : []),
    ...(args.bot.provider === "claude" ? [claudeHome] : []),
    ...(args.bot.provider === "opencode" ? [env.XDG_DATA_HOME, env.XDG_CONFIG_HOME] : []),
    ...(args.bot.provider === "opencode" && env.OPENCODE_CONFIG ? [dirname(env.OPENCODE_CONFIG)] : []),
    // The managed auth symlink shares token refreshes, but no host sessions/config.
    codexCredential,
    codexAlias,
  ].filter((path): path is string => !!path && existsSync(path))
  const workspace = [args.bot.homeDir, args.fingerprint.cwd, env.TOURI_PROJECT_DATA_DIR]
    .filter((path): path is string => !!path && existsSync(path))
    .map(canonicalPath)
  const executables = [
    ...authentication.executables,
    command,
    kernel.paths.sidecarBinary,
    args.mcp?.command,
    ...["node", "bun"].map((name) => Bun.which(name, { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin" })),
  ].filter((path): path is string => !!path && existsSync(path))
  const programs = [...new Set(executables.flatMap(linuxProgramFiles))]
  const internal = [...readonly, ...state, ...workspace, ...programs].filter(existsSync)
  const mounts = [...linuxSandboxBase]
  const bind = (path: string, write: boolean) => {
    const source = canonicalPath(path)
    if (source === "/" || withinFolder("/proc", source) || source === "/dev" || withinFolder("/sys", source))
      throw new Error(specificFoldersRequired)
    mounts.push(write ? "--bind" : "--ro-bind", source, path)
  }
  const writableWorkspace = (path: string) =>
    args.bot.access !== "read-only" &&
    !folders.some((folder) => folder.access === "read-only" && withinFolder(folder.path, path))
  for (const folder of [...folders].sort((a, b) => a.path.length - b.path.length))
    bind(folder.path, args.bot.access !== "read-only" && folder.access === "read-write")
  for (const path of [...new Set(workspace)]) bind(path, writableWorkspace(path))
  // Explicit RO trees win over a broader writable workspace.
  for (const folder of folders.filter((folder) => folder.access === "read-only")) bind(folder.path, false)
  // Broad, explicitly selected homes must still hide protected application data.
  const exposed = [...folders.map((folder) => folder.path), ...workspace, ...internal]
  for (const path of linuxProtectedFolders(kernel.paths.appData, home).filter(existsSync)) {
    // Mask only when a broader mount would show it; otherwise it simply does not exist.
    if (!statSync(path).isDirectory() || !exposed.some((entry) => withinFolder(canonicalPath(entry), path))) continue
    mounts.push("--tmpfs", path)
    for (const entry of folders.filter((folder) => withinFolder(path, folder.path)))
      bind(entry.path, args.bot.access !== "read-only" && entry.access === "read-write")
    for (const entry of [...new Set(internal.filter((entry) => withinFolder(path, entry)))].sort(
      (a, b) => a.length - b.length,
    ))
      bind(entry, state.includes(entry) || (workspace.includes(entry) && writableWorkspace(entry)))
    mounts.push("--remount-ro", path)
  }
  for (const path of state) bind(path, true)
  for (const path of readonly.filter(existsSync)) bind(path, false)
  // This file selects which host authentication variables may cross next turn.
  // Provider bookkeeping remains writable, but tools cannot change that selection.
  if (args.bot.provider === "codex" && env.CODEX_HOME && existsSync(join(env.CODEX_HOME, "config.toml")))
    bind(join(env.CODEX_HOME, "config.toml"), false)
  for (const path of programs) bind(path, false)
  if (claudeCredential) mounts.push("--bind", claudeCredential, join(claudeHome, ".credentials.json"))
  // Reconstruct executable links without binding their parent directories.
  mounts.push(...linuxProgramLinks(executables, linuxSandboxBase))
  // Existing runtime symlinks (e.g. Codex auth) must resolve to just their leaf.
  // No host /proc or /dev survives: both are freshly mounted by the base policy.
  mounts.push("--remount-ro", "/")
  return mounts
}
