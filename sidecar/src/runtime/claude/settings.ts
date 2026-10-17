import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { StartTurnArgs } from "@touri/contracts"
import { turnFolders } from "../folder-access"
import { asRecord } from "../utils"

// Only authentication configuration may cross the user-settings boundary.
// Pass credentials through the child environment, never process arguments or generated files.
const authFields = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod", "forceLoginOrgUUID"]
const authEnvKeys = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FOUNDRY_BASE_URL",
])

// Plan mode blocks every MCP tool call, so read-only bots use dontAsk: anything not allowed is denied.
// touri's own router denies mutating touri tools for read-only callers (policyGate), so mcp__touri__* is safe.
export const readOnlyAllow = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "mcp__touri__*"]
export const readOnlyDeny = ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit"]

export const claudeSettings = async (args: StartTurnArgs, env: Record<string, string>) => {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "settings.json")
  let content = "{}"
  if (args.execution) {
    const child = args.execution.spawn({ cmd: "cat", args: [path], env, cwd: args.fingerprint.cwd })
    if (!child.success) throw new Error(child.error)
    const abort = () => child.kill("SIGTERM")
    args.signal.addEventListener("abort", abort, { once: true })
    try {
      if (args.signal.aborted) abort()
      const [output, , exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exit.code === 0) content = output
      args.signal.throwIfAborted()
    } finally {
      args.signal.removeEventListener("abort", abort)
    }
  } else {
    try {
      content = readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const user = asRecord(JSON.parse(content)) ?? {}
  const auth = Object.fromEntries(authFields.filter((key) => user[key] !== undefined).map((key) => [key, user[key]]))
  const authEnv = Object.fromEntries(
    Object.entries(asRecord(user.env) ?? {}).filter(
      ([key, value]) => authEnvKeys.has(key) && typeof value === "string",
    ),
  )
  return {
    authEnv,
    settings: {
      ...auth,
      permissions: {
        allow: args.conversationOnly ? [] : args.bot.access === "read-only" ? readOnlyAllow : [],
        deny: [
          ...(args.conversationOnly ? ["*"] : []),
          ...(args.bot.access === "read-only" ? readOnlyDeny : []),
          ...turnFolders(args)
            .filter((folder) => folder.access === "read-only")
            .flatMap((folder) =>
              ["Write", "Edit", "MultiEdit", "NotebookEdit"].map((tool) => `${tool}(/${folder.path}/**)`),
            ),
        ],
        // default mode also auto-allows read-only Bash. An explicit ask rule gates every command.
        ask: args.bot.approvals === "on-request" && args.bot.access !== "read-only" ? ["Bash"] : [],
      },
      // Permission-prompt allow responses are consumed by the CLI, not shown to
      // the model. Post-tool context reports consent without changing tool input.
      // MCP hooks reuse the authenticated shim in local and VM executions.
      hooks: Object.fromEntries(
        ["PostToolUse", "PostToolUseFailure"].map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "mcp_tool",
                  server: "touri",
                  tool: "approval_context",
                  timeout: 10,
                  input: {
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the Claude hook engine
                    tool_name: "${tool_name}",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the Claude hook engine
                    tool_use_id: "${tool_use_id}",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded by the Claude hook engine
                    input: "${tool_input}",
                    hook_event_name: event,
                  },
                },
              ],
            },
          ],
        ]),
      ),
    },
  }
}
