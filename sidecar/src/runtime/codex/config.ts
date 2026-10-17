import type { StartTurnArgs } from "@touri/contracts"
import { canonicalPath } from "../../kernel/bot-folders"
import { writableTurnFolders } from "../folder-access"

export const outerSeatbelt = (args: StartTurnArgs, platform = process.platform): boolean =>
  platform === "darwin" && !args.execution && args.bot.access !== "full"

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
  if (args.bot.access === "full")
    return { ...reviewer, sandbox: "danger-full-access", approvalPolicy: args.bot.approvals, config }
  // On macOS every local turn already runs inside touri's Seatbelt profile (spawnFolderProvider), which
  // limits writes to the same roots and also hides sensitive folders. Seatbelt refuses to apply a second
  // sandbox under any profile with a deny rule, so Codex's own sandbox could never start there and every
  // command became a "run without sandbox" approval. The outer profile is the boundary on macOS.
  if (outerSeatbelt(args, platform))
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
