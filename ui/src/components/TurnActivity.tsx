import type { Bot, Message, Run } from "@touri/contracts"
import { lazy, type ReactNode, Suspense, useContext, useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { ChannelBrowserScope } from "../features/channelBrowser/ChannelBrowser"
import { InlinePreviewContext } from "../features/desktop/InlineLivePreview"
import { type Locale, t } from "../i18n"
import { ActivityMark } from "./ActivityMark"
import { getBrowserActivityTools } from "./browserActivityPresentation"
import type { BrowserContinuationActivity } from "./browserContinuationActivity"
import { Disclosure } from "./Disclosure"
import { MarkdownContent } from "./MarkdownContent"
import type { MascotState } from "./mascotState"
import { isSessionRecoveryDiagnostic, sessionRecoveryDiagnosticText } from "./sessionRecoveryPresentation"
import { ToolCallCard } from "./ToolCallCard"
import { toolPresentation, toolStatus } from "./toolPresentation"
import { activityGroupLabels, activityGroups, activitySummary, activityTools, approvalTools } from "./turnActivityModel"
import "./turn-activity.css"

const BrowserActivityCard = lazy(() =>
  import("./BrowserActivityCard").then((module) => ({ default: module.BrowserActivityCard })),
)

/** The single browser card of a turn, with the bot's own preview context. */
export const BrowserTurnCard = ({
  message,
  run,
  bot,
  activity,
  locale = "pt-BR",
  children,
}: {
  message: Message
  run?: Run | undefined
  bot?: Bot | undefined
  activity?: BrowserContinuationActivity | undefined
  locale?: Locale
  children?: ReactNode
}) => {
  const inlinePreview = useContext(InlinePreviewContext)
  const value = inlinePreview && {
    ...inlinePreview,
    bot: bot ?? inlinePreview.bot,
    machine: bot && inlinePreview.bot?.id !== bot.id ? undefined : inlinePreview.machine,
  }
  const sessionDetails = getSessionRecoveryDetails(message, run, locale)
  const history = sessionDetails ? (
    <>
      {children}
      {sessionDetails}
    </>
  ) : (
    children
  )
  const card = (
    <Suspense fallback={<div className="browser-card-loading" aria-busy="true" />}>
      <BrowserActivityCard
        parts={activity?.parts ?? message.parts}
        threadId={message.threadId}
        runId={activity?.runId ?? message.runId}
        waitingForPerson={
          run?.browserWaitingForPerson &&
          !message.parts.some(
            (part) =>
              part.type === "notice" &&
              part.code === "run_failed" &&
              part.text === "No one took over in time. Ask again when you can.",
          )
        }
        finished={activity?.finished ?? message.status !== "streaming"}
        createdAt={message.createdAt}
        botName={message.sender?.name ?? bot?.name ?? "touri"}
        locale={locale}
      >
        {history}
      </BrowserActivityCard>
    </Suspense>
  )

  return (
    <ChannelBrowserScope runId={message.runId}>
      {value ? <InlinePreviewContext.Provider value={value}>{card}</InlinePreviewContext.Provider> : card}
    </ChannelBrowserScope>
  )
}

export const TurnActivity = ({
  message,
  run,
  browserActivity,
  hideBrowserActivity = false,
  botName: _botName,
  api,
  bot,
  state,
  preparingEnvironment,
  onCancel,
  onFocusApproval,
  browserFlow,
  hideBrowserCard = false,
  embedded = false,
  locale = "pt-BR",
}: {
  message: Message
  run?: Run | undefined
  browserActivity?: BrowserContinuationActivity | undefined
  hideBrowserActivity?: boolean | undefined
  botName?: string
  api?: UiApi | undefined
  bot?: Bot | undefined
  state: MascotState
  preparingEnvironment?: boolean | undefined
  onCancel?: ((runId: string) => Promise<void>) | undefined
  onFocusApproval?: ((approvalId: string) => void) | undefined
  /** Narration and step rows folded into the finished browser card. */
  browserFlow?: ReactNode
  /** The live card is rendered after the last step by the message instead. */
  embedded?: boolean
  hideBrowserCard?: boolean
  locale?: Locale
}) => {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [technicalExpanded, setTechnicalExpanded] = useState(false)
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
  const browserOnly = browserTools.length > 0 && groups.length === 0 && approvals.size === 0 && reasoning.length === 0
  const browserCard = browserTools.length > 0 && !hideBrowserCard && !hideBrowserActivity && (
    <BrowserTurnCard message={message} run={run} bot={bot} activity={browserActivity} locale={locale}>
      {browserFlow}
    </BrowserTurnCard>
  )
  const getDetails = () => (
    <>
      {groups.map(({ kind, tools: entries }) => (
        <section key={kind} className="turn-activity-group" aria-label={t(activityGroupLabels[kind], {}, locale)}>
          <h4>
            {t(activityGroupLabels[kind], {}, locale)} · {entries.length}
          </h4>
          {entries.map((part) => {
            const presentation = toolPresentation(part)
            return (
              <p key={part.callId} className="turn-activity-step">
                <strong>{presentation.name}</strong>
                <span>{presentation.summary}</span>
                <small>{t(getStepStatus(toolStatus(part, !live)), {}, locale)}</small>
              </p>
            )
          })}
        </section>
      ))}
      {browserTools.length === 0 && getSessionRecoveryDetails(message, run, locale)}
      {reasoning.length > 0 && (
        <section className="turn-activity-group chat-reasoning" aria-label={t("Reasoning", {}, locale)}>
          <h4>{t("Reasoning", {}, locale)}</h4>
          <MarkdownContent content={reasoning.join("\n\n")} streaming={live} />
        </section>
      )}
      {groups.length > 0 && (
        <Disclosure
          summary={t("Detalhes técnicos", {}, locale)}
          open={technicalExpanded}
          onOpenChange={setTechnicalExpanded}
        >
          {technicalExpanded &&
            groups
              .flatMap((group) => group.tools)
              .map((part) => (
                <ToolCallCard key={part.callId} part={part} api={api} finished={!live} createdAt={message.createdAt} />
              ))}
        </Disclosure>
      )}
    </>
  )
  if (embedded) return getDetails()

  return (
    <div className="turn-activity" data-turn-activity data-running={live}>
      {browserCard}
      {browserOnly ? null : live ? (
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
      ) : !live ? (
        <button
          className="turn-activity-toggle"
          type="button"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <svg
            className="turn-activity-chevron"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
          {activitySummary(message, run, locale)}
        </button>
      ) : null}
      <div id={id} hidden={!expanded} className="turn-activity-details">
        {expanded && getDetails()}
      </div>
    </div>
  )
}

const getSessionRecoveryDetails = (message: Message, run: Run | undefined, locale: Locale): ReactNode => {
  if (run?.status !== "succeeded" || !message.parts.some(isSessionRecoveryDiagnostic)) return null

  return (
    <section className="turn-activity-group" aria-label={t("Detalhes técnicos", {}, locale)}>
      <h4>{t("Detalhes técnicos", {}, locale)}</h4>
      <p>{t(sessionRecoveryDiagnosticText, {}, locale)}</p>
    </section>
  )
}

const getStepStatus = (status: ReturnType<typeof toolStatus>) => {
  if (status === "completed") return "Finished"
  if (status === "running") return "Em execução"
  if (status === "pending") return "Waiting for approval"
  if (status === "denied") return "Denied"
  if (status === "closed") return "Encerrado"
  return "failed"
}
