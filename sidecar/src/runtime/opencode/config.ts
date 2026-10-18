import type { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, StartTurnArgs } from "@touri/contracts"
import { withDeadline } from "../../kernel/policy"
import { turnFolders } from "../folder-access"
import { asRecord, resolveExecutable } from "../utils"

export const openCodeBinary = (env: Record<string, string>, command?: string) => {
  if (command || env.TOURI_OPENCODE_BIN)
    return resolveExecutable({ command: command ?? env.TOURI_OPENCODE_BIN ?? "opencode", env })
  const installed = resolveExecutable({ command: join(env.HOME ?? homedir(), ".opencode/bin/opencode"), env })
  return installed.success ? installed : resolveExecutable({ command: "opencode", env })
}
export const openCodeAuthPath = (home: string, dataHome?: string) =>
  join(dataHome ?? join(home, ".local/share"), "opencode/auth.json")
export const fullAccess = (bot: Pick<Bot, "access" | "approvals">) => bot.access === "full" && bot.approvals === "never"

export const openCodePermissions = (bot: Pick<Bot, "access" | "approvals">): Record<string, string> => ({
  "*": fullAccess(bot) ? "allow" : bot.access === "read-only" ? "deny" : "ask",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  ...Object.fromEntries(
    [
      "history_search",
      "history_read",
      "project_info",
      "routine_list",
      "mem0_search",
      "process_list",
      "process_logs",
      "secret_list",
      "browser_list_tabs",
      "browser_snapshot",
      "browser_screenshot",
      "computer_screenshot",
      "computer_frontmost",
    ].map((tool) => [`touri_${tool}`, "allow"]),
  ),
  // No subagent or interactive question may escape the touri permission bridge.
  task: "deny",
  skill: "deny",
  question: "deny",
  ...(bot.access === "read-only" ? { edit: "deny", bash: "deny", external_directory: "deny" } : {}),
})

export const openCodeConfig = (args: StartTurnArgs) => {
  const folders = turnFolders(args)
  const permission: Record<string, string | Record<string, string>> = {
    ...openCodePermissions(args.bot),
    ...(folders.length
      ? {
          external_directory: {
            "*": "deny",
            [`${args.bot.homeDir}/**`]: "allow",
            ...Object.fromEntries(
              folders.map((folder) => [folder.path === "/" ? "/**" : `${folder.path}/**`, "allow"]),
            ),
          },
          ...(args.bot.access !== "read-only"
            ? {
                edit: {
                  "*": fullAccess(args.bot) ? "allow" : "ask",
                  ...Object.fromEntries(
                    folders
                      .filter((folder) => folder.access === "read-only")
                      .map((folder) => [`${folder.path}/**`, "deny"]),
                  ),
                },
              }
            : {}),
        }
      : {}),
  }
  if (args.conversationOnly) {
    for (const key of Object.keys(permission)) delete permission[key]
    permission["*"] = "deny"
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    default_agent: "touri",
    permission,
    agent: { touri: { mode: "primary", description: "Assistente do touri", permission } },
    plugin: [],
    mcp: args.conversationOnly
      ? {}
      : {
          touri: {
            type: "local",
            command: [args.mcp.command, ...args.mcp.args],
            environment: args.mcp.env,
            enabled: true,
          },
        },
  }
}

/** Copy credentials only. wellknown entries can import remote permission/plugin config. */
export const credentialAuth = (content: string, kernel: Kernel): string => {
  const auth = asRecord(JSON.parse(content))
  if (!auth) throw new Error("Login JSON do OpenCode inválido")
  const safe = Object.fromEntries(
    Object.entries(auth).filter(([, value]) => {
      const entry = asRecord(value)
      return entry?.type === "api" || entry?.type === "oauth"
    }),
  )
  const redact = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 6) kernel.addRedactionValue(value)
    else if (value && typeof value === "object") for (const item of Object.values(value)) redact(item)
  }
  redact(safe)
  return JSON.stringify(safe)
}

export const readOpenCodeAuth = (kernel: Kernel, env: Record<string, string>): string => {
  try {
    return credentialAuth(readFileSync(openCodeAuthPath(env.HOME ?? homedir(), env.XDG_DATA_HOME), "utf8"), kernel)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "{}"
    throw error
  }
}

export const providerSecretEnv = async (
  kernel: Kernel,
  bot: Pick<Bot, "projectId">,
  signal?: AbortSignal,
  projectScoped = true,
): Promise<Record<string, string>> => {
  const rows = (kernel.db as Database)
    .query(
      "SELECT name, keychain_account, usage_json FROM secrets WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NULL DESC",
    )
    .all(projectScoped ? bot.projectId : null) as Array<{ name: string; keychain_account: string; usage_json: string }>
  const env: Record<string, string> = {}
  for (const row of rows) {
    if (
      !/^(OPENROUTER|DEEPSEEK|OPENAI|ANTHROPIC|GOOGLE|GROQ|MISTRAL|XAI)_API_KEY$/.test(row.name) ||
      asRecord(JSON.parse(row.usage_json))?.env !== true
    )
      continue
    const result = await withDeadline({
      operation: () => kernel.callHost("keychain.get", { account: row.keychain_account }),
      timeoutMs: 3000,
      ...(signal ? { signal } : {}),
    })
    signal?.throwIfAborted()
    if (result.success && result.value.value) {
      env[row.name] = result.value.value
      kernel.addRedactionValue(result.value.value)
    }
  }
  return env
}

/** CLI data persists per bot; configuration is private and replaced on every turn. */
export const isolatedOpenCodeEnv = (
  base: Record<string, string>,
  runDir: string,
  dataDir: string,
  configPath: string,
): Record<string, string> => {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => !key.startsWith("OPENCODE_") && !["NODE_OPTIONS", "BUN_OPTIONS"].includes(key),
    ),
  )
  return {
    ...env,
    XDG_CONFIG_HOME: `${runDir}/xdg-config`,
    XDG_DATA_HOME: dataDir,
    XDG_STATE_HOME: `${dataDir}/state`,
    XDG_CACHE_HOME: `${dataDir}/cache`,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: `${runDir}/config`,
    OPENCODE_TEST_HOME: `${runDir}/home`,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: `${runDir}/managed`,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_PURE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  }
}
