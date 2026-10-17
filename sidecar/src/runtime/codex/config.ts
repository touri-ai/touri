import type { StartTurnArgs } from "@touri/contracts"
import { canonicalPath } from "../../kernel/bot-folders"
import { writableTurnFolders } from "../folder-access"

export const codexAccessParams = (args: StartTurnArgs): Record<string, unknown> => {
  const reviewer = { approvalsReviewer: "user" }
  const temporary = !args.execution ? args.env.TMPDIR : undefined
  const config = temporary
    ? {
        shell_environment_policy: {
          set: { TMPDIR: temporary, TMP: temporary, TEMP: temporary, TMPPREFIX: `${temporary}/zsh` },
        },
      }
    : {}
  if (args.bot.access === "read-only") return { ...reviewer, sandbox: "read-only", approvalPolicy: "never", config }
  if (args.bot.access === "full")
    return { ...reviewer, sandbox: "danger-full-access", approvalPolicy: args.bot.approvals, config }
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
