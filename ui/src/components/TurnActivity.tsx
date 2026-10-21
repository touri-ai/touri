import type { Message, Run } from "@touri/contracts"
import type { AvatarIdentity } from "@touri/contracts/avatar"
import { useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { type Locale, t } from "../i18n"
import { ActivityMark } from "./ActivityMark"
import { BrowserActivityCard } from "./BrowserActivityCard"
import { getBrowserActivityTools } from "./browserActivityPresentation"
import type { BrowserContinuationActivity } from "./browserContinuationActivity"
import { MarkdownContent } from "./MarkdownContent"
import type { MascotState } from "./mascotState"
import { ToolCallCard } from "./ToolCallCard"
import { activityGroupLabels, activityGroups, activitySummary, activityTools, approvalTools } from "./turnActivityModel"
import "./turn-activity.css"

export const TurnActivity = ({
  message,
  run,
  browserActivity,
  hideBrowserActivity = false,
  botName,
  api,
  bot,
  state,
  preparingEnvironment,
  onCancel,
  onFocusApproval,
  locale = "pt-BR",
}: {
  message: Message
  run?: Run | undefined
  browserActivity?: BrowserContinuationActivity | undefined
  hideBrowserActivity?: boolean | undefined
  botName?: string
  api?: UiApi | undefined
  bot?: AvatarIdentity | undefined
  state: MascotState
  preparingEnvironment?: boolean | undefined
  onCancel?: ((runId: string) => Promise<void>) | undefined
  onFocusApproval?: ((approvalId: string) => void) | undefined
  locale?: Locale
}) => {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const live = message.status === "streaming"
  useEffect(() => {
    if (!live) setExpanded(false)
  }, [live])
  const tools = activityTools(message.parts)
  const browserTools = getBrowserActivityTools(message.parts)
  const browserCallIds = new Set(browserTools.map((part) => part.callId))
  const approvals = new Set([...approvalTools(message.parts).values()].map((part) => part.callId))
  const groups = activityGroups(tools.filter((part) => !approvals.has(part.callId) && !browserCallIds.has(part.callId)))
  const reasoning = message.parts.flatMap((part) => (part.type === "reasoning" && part.text.trim() ? [part.text] : []))
  return (
    <div className="turn-activity" data-running={live}>
      {browserTools.length > 0 && !hideBrowserActivity && (
        <BrowserActivityCard
          parts={browserActivity?.parts ?? message.parts}
          finished={browserActivity?.finished ?? !live}
          createdAt={message.createdAt}
          threadId={message.threadId}
          runId={browserActivity?.runId ?? message.runId ?? run?.id ?? null}
          botName={botName ?? message.sender?.name ?? "touri"}
          locale={locale}
        />
      )}
      {live ? (
        <ActivityMark
          state={state}
          run={run}
          updatedAt={message.updatedAt}
          parts={message.parts}
          bot={bot}
          threadId={message.threadId}
          api={api}
          onCancel={onCancel}
          preparingEnvironment={preparingEnvironment}
          locale={locale}
          reasoningId={id}
          reasoningExpanded={expanded}
          onExpandReasoning={() => setExpanded((value) => !value)}
          onFocusApproval={onFocusApproval}
        />
      ) : (
        <button
          className="turn-activity-toggle"
          type="button"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <svg
            className="turn-activity-chevron"
            width="6"
            height="14"
            viewBox="8 0 10 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
          {activitySummary(message, run, locale)}
        </button>
      )}
      <div id={id} hidden={!expanded} className="turn-activity-details">
        {expanded && (
          <>
            {groups.map(({ kind, tools: entries }) => (
              <section key={kind} className="turn-activity-group" aria-label={t(activityGroupLabels[kind], {}, locale)}>
                <h4>
                  {t(activityGroupLabels[kind], {}, locale)} · {entries.length}
                </h4>
                {entries.map((part) => (
                  <ToolCallCard
                    key={part.callId}
                    part={part}
                    api={api}
                    finished={!live}
                    createdAt={message.createdAt}
                  />
                ))}
              </section>
            ))}
            {reasoning.length > 0 && (
              <section className="turn-activity-group chat-reasoning" aria-label={t("Reasoning", {}, locale)}>
                <h4>{t("Reasoning", {}, locale)}</h4>
                <MarkdownContent content={reasoning.join("\n\n")} streaming={live} />
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
