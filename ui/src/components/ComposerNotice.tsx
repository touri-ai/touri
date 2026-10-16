import type { Bot, MachineState, Message } from "@touri/contracts"
import type { UiApi } from "../api/client"
import { localizeNotice, t } from "../i18n"
import { runErrorFor } from "../runError"
import { ErrorText } from "./ErrorDetails"
import { MachineServiceButton } from "./MachineServiceButton"

export const ComposerNotice = ({
  bot,
  latestReply,
  machine,
  active,
  loginFlowShown = false,
  api,
  onOpenPermissions,
  onOpenProviderLogin,
  onRetry,
}: {
  bot: Bot | null
  latestReply: Message | undefined
  machine: MachineState | undefined
  active: boolean
  loginFlowShown?: boolean
  api: UiApi
  onOpenPermissions?: (() => void) | undefined
  onOpenProviderLogin?: (() => void) | undefined
  onRetry: (runId: string) => Promise<void>
}) => {
  if (active) return null
  const notice =
    latestReply?.status === "failed"
      ? latestReply.parts.find((part) => part.type === "notice" && part.level === "error")
      : undefined
  const authNeeded = !loginFlowShown && notice?.type === "notice" && notice.text.startsWith("cli_auth:")
  const serviceDown =
    machine?.status !== "running" &&
    machine?.status !== "starting" &&
    notice?.type === "notice" &&
    /^machine_service_(?:unavailable|start_failed):/.test(notice.text)
  const machineFailed = bot?.machine === "vm" && machine?.status === "error"
  if (!authNeeded && !serviceDown && !machineFailed) return null
  const provider = bot?.provider === "opencode" ? "OpenCode" : bot?.provider === "claude" ? "Claude Code" : "Codex"
  const error = latestReply ? runErrorFor(latestReply) : null
  return (
    <aside className="composer-notice" aria-label={authNeeded ? t("Authentication required") : t("Computer notice")}>
      <div className="composer-notice-copy">
        <strong>{authNeeded ? t("Sign in to continue", { provider }) : t("The computer needs attention")}</strong>
        <div>
          {authNeeded ? (
            t("Connect your account to send messages again.")
          ) : (
            <ErrorText
              code={error?.code ?? machine?.errorCode}
              text={
                error?.detail ||
                (machine?.error && localizeNotice(machine.error)) ||
                t("Check the computer and try again. Your files are safe.")
              }
            />
          )}
        </div>
      </div>
      {authNeeded ? (
        <button
          type="button"
          className="button button-brand"
          aria-label={t("Entrar no provedor nesta máquina", { provider })}
          onClick={onOpenProviderLogin ?? onOpenPermissions}
        >
          {t("Sign in to provider")}
        </button>
      ) : serviceDown || /TOURI-E800[12]/.test(machine?.errorCode ?? "") ? (
        <MachineServiceButton api={api} {...(bot ? { botId: bot.id } : {})} />
      ) : latestReply?.runId ? (
        <button type="button" className="button button-quiet" onClick={() => void onRetry(latestReply.runId ?? "")}>
          {t("Tentar novamente")}
        </button>
      ) : (
        <button type="button" className="button button-quiet" onClick={onOpenPermissions}>
          {t("View bot settings")}
        </button>
      )}
    </aside>
  )
}
