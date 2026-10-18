import type { Bot } from "@touri/contracts"
import { useId, useState } from "react"
import { type Locale, t } from "../../i18n"
import { readWorkspaceState, saveWorkspaceState } from "../../workspaceState"
import { getComplementaryJobs, type JobTemplate } from "./catalog"
import "./jobs.css"

export type TeamFollowup = { botId: string; partnerId: string }

export const TeamNextStep = ({
  bots,
  selectedBotId,
  followup,
  onChooseJob,
  onGroup,
  onDismissFollowup,
  locale = "pt-BR",
}: {
  bots: Bot[]
  selectedBotId: string | null
  followup: TeamFollowup | null
  onChooseJob: (job: JobTemplate) => void
  onGroup: (bot: Bot, partner: Bot) => void
  onDismissFollowup: () => void
  locale?: Locale
}) => {
  const id = useId()
  const [dismissed, setDismissed] = useState(() => readWorkspaceState().teamSuggestionDismissed ?? false)
  const activeBots = bots.filter((bot) => !bot.archivedAt)
  const bot = activeBots.find((bot) => bot.id === followup?.botId && bot.id === selectedBotId)
  const partner = activeBots.find((bot) => bot.id === followup?.partnerId)
  const canOfferGroup = Boolean(bot && partner)
  const canSuggestJobs = activeBots.length > 0 && activeBots.length < 3 && !dismissed

  if (!canOfferGroup && !canSuggestJobs) return null

  const dismiss = (): void => {
    setDismissed(true)
    saveWorkspaceState({ teamSuggestionDismissed: true })
    if (canOfferGroup) onDismissFollowup()
  }

  return (
    <section className="team-next-step" aria-labelledby={id}>
      {bot && partner ? (
        <button id={id} type="button" className="text-button" onClick={() => onGroup(bot, partner)}>
          {t("Work in a group with {name}?", { name: partner.name }, locale)}
        </button>
      ) : (
        <div>
          <h2 id={id}>{t("Put another bot to work with you", {}, locale)}</h2>
          <p>{t("Bots can collaborate in a group and follow routines.", {}, locale)}</p>
          <ul className="team-job-suggestions">
            {getComplementaryJobs(activeBots, locale).map((job) => (
              <li key={job.id}>
                <button type="button" className="text-button" onClick={() => onChooseJob(job)}>
                  {job.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button type="button" className="text-button" aria-label={t("Dismiss next step", {}, locale)} onClick={dismiss}>
        ×
      </button>
    </section>
  )
}
