import type { Bot } from "@touri/contracts"
import { needsRepository } from "../features/jobs/catalog"
import { t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import "./conversation-start.css"

export const ConversationStart = ({
  bot,
  onChoose,
  onFolder,
  onAttach,
}: {
  bot: Bot | null
  onChoose: (prompt: string) => void
  onFolder?: (() => void) | undefined
  onAttach?: (() => void) | undefined
}) => {
  const repository = needsRepository(bot)
  const hasFolder = bot?.machine !== "cloud" && !!(bot?.projectId || bot?.folders?.length || bot?.anyFolderAccess)
  const title = t("onboarding.conversation", { name: bot?.name ?? "touri" })
  return (
    <section className="conversation-start" aria-label={title}>
      {bot && (
        <div className="conversation-start-avatar">
          <BotAvatar bot={bot} size={36} state="idle" />
        </div>
      )}
      <h2>{title}</h2>
      <p>
        {t(
          repository && !hasFolder
            ? bot?.machine === "cloud"
              ? "onboarding.repositoryUpload"
              : "onboarding.repositoryNeeded"
            : "onboarding.notes",
        )}
      </p>
      <div className="conversation-examples">
        {repository &&
          bot?.machine !== "cloud" &&
          (hasFolder ? (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => onChoose(t("onboarding.repositoryPrompt"))}
            >
              {t("onboarding.repositoryAction")}
            </button>
          ) : onFolder ? (
            <button type="button" className="button button-quiet" onClick={onFolder}>
              {t("onboarding.repositoryFolder")}
            </button>
          ) : (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => onChoose(t("onboarding.repositoryRequest"))}
            >
              {t("onboarding.repositoryFolder")}
            </button>
          ))}
        <button type="button" className="button button-quiet" onClick={() => onChoose(t("onboarding.examplePrompt"))}>
          {t("onboarding.example")}
        </button>
        {onAttach && (
          <button type="button" className="button button-quiet" onClick={onAttach}>
            {t("Anexar arquivo")}
          </button>
        )}
      </div>
    </section>
  )
}
