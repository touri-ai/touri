import type { StartTurnArgs } from "@touri/contracts"
import { canonicalPath } from "../../kernel/bot-folders"
import { hostFolderAccessAvailable } from "../../kernel/folder-capability"
import { writableTurnFolders } from "../folder-access"

export const outerFolderSandbox = (args: StartTurnArgs, platform = process.platform): boolean =>
  !args.execution && (platform === "darwin" || (platform === "linux" && hostFolderAccessAvailable()))

export const codexAccessParams = (args: StartTurnArgs, platform = process.platform): Record<string, unknown> => {
  const reviewer = { approvalsReviewer: "user" }
  const temporary = !args.execution ? args.env.TMPDIR : undefined
  const config = temporary
    ? {
        shell_environment_policy: {
          set: { TMPDIR: temporary, TMP: temporary, TEMP: temporary, TMPPREFIX: `${temporary}/zsh` },
        },
      }
    : {}
  if (args.conversationOnly)
    return {
      ...reviewer,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        ...config,
        features: {
          shell_tool: false,
          apply_patch_freeform: false,
          view_image: false,
          image_generation: false,
          apps: false,
          plugins: false,
          code_mode: false,
          code_mode_host: false,
          multi_agent: false,
        },
        tools: { view_image: false },
        web_search: "disabled",
        mcp_servers: {},
      },
    }
  if (args.bot.access === "full")
    return { ...reviewer, sandbox: "danger-full-access", approvalPolicy: args.bot.approvals, config }
  // Host folder grants already have an inherited platform boundary. Avoid a
  // nested provider sandbox that cannot initialize inside that boundary.
  if (outerFolderSandbox(args, platform))
    return {
      ...reviewer,
      sandbox: "danger-full-access",
      approvalPolicy: args.bot.access === "read-only" ? "never" : args.bot.approvals,
      config,
    }
  if (args.bot.access === "read-only") return { ...reviewer, sandbox: "read-only", approvalPolicy: "never", config }
  const roots = [
    args.bot.homeDir,
    args.fingerprint.cwd,
    ...writableTurnFolders(args),
    ...(args.env.TOURI_PROJECT_DATA_DIR ? [args.env.TOURI_PROJECT_DATA_DIR] : []),
    ...(temporary ? [temporary] : []),
  ]
  return {
    ...reviewer,
    sandbox: "workspace-write",
    approvalPolicy: args.bot.approvals,
    config: {
      ...config,
      sandbox_workspace_write: {
        writable_roots: [...new Set(args.execution ? roots : roots.map(canonicalPath))],
        network_access: true,
      },
    },
  }
}
