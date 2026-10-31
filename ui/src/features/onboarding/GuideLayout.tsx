import type { AgentImportProgress, AvatarMood, Bot } from "@touri/contracts"
import type { KeyboardEventHandler, ReactNode, RefObject } from "react"
import { BotAvatar } from "../../components/BotAvatar"
import { Button } from "../../components/Button"
import { type TranslationKey, t } from "../../i18n"
import {
  type GuideStep,
  getChannels,
  getGuideMood,
  getStage,
  guideBot,
  guideStages,
  type WorkspaceDraft,
} from "./guide"

export const GuideLayout = ({
  step,
  draft,
  bots,
  progress,
  replies,
  computer,
  team,
  task,
  busy,
  error,
  heading,
  onBack,
  onKeyDown,
  children,
}: {
  step: GuideStep
  draft: WorkspaceDraft
  bots: (Pick<Bot, "id" | "name" | "color"> & { agentKey?: string })[]
  progress: AgentImportProgress[]
  replies: string[]
  computer: string
  team: boolean
  task: string
  busy: boolean
  error: string | null
  heading: RefObject<HTMLHeadingElement | null>
  onBack: () => void
  onKeyDown: KeyboardEventHandler<HTMLElement>
  children: ReactNode
}) => {
  const stage = getStage(step)
  const question = questions[step]
  return (
    <main className="ob-screen" onKeyDown={onKeyDown}>
      <div className="ob-shell">
        <section className="ob-conversation" aria-labelledby="ob-title" aria-busy={busy}>
          <header className="ob-top">
            <Button variant="quiet" onClick={onBack} disabled={busy || step === "ready"} aria-label={t("Back")}>
              ‹
            </Button>
            <div
              className="ob-segments"
              role="progressbar"
              aria-label={t("ob.progress")}
              aria-valuemin={1}
              aria-valuemax={7}
              aria-valuenow={stage + 1}
            >
              {guideStages.map((label, index) => (
                <span key={label} data-state={getSegmentState(index, stage)} />
              ))}
            </div>
            <span className="ob-position">
              {stage + 1}/7 · {t(guideStages[stage] ?? "ob.workspace")}
            </span>
          </header>
          <div className="ob-pane">
            {replies.length > 0 && (
              <section className="ob-replies" aria-label={t("ob.answers")}>
                {Array.from(new Set(replies.slice(-2))).map((reply) => (
                  <p key={reply}>{reply}</p>
                ))}
              </section>
            )}
            <div className="ob-question">
              <BotAvatar
                bot={guideBot}
                size={56}
                mood={getGuideMood(step, Boolean(error), busy && step === "importing")}
              />
              <div>
                {step === "workspace" && <small>{t("ob.hello")}</small>}
                <h1 ref={heading} tabIndex={-1} id="ob-title">
                  {t(question.title, { name: draft.name || t("ob.yourWorkspace") })}
                </h1>
                <p>{t(question.detail)}</p>
              </div>
            </div>
            {children}
            {error && (
              <p className="ob-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </section>
        <aside className="ob-live" aria-label={t("ob.liveWorkspace")}>
          <div className="ob-live-heading">
            <span>{t("ob.yourTouri")}</span>
            <span>● {t("ob.live")}</span>
          </div>
          <div className="ob-workspace">
            <div className="ob-workspace-name">
              <span className="ob-workspace-mark" style={{ background: draft.color }}>
                {draft.name.slice(0, 1).toUpperCase() || "t"}
              </span>
              <strong>{draft.name || t("ob.yourWorkspace")}</strong>
            </div>
            <PreviewSection title={t("ob.channels")} highlighted={stage === 1}>
              {getChannels(draft.topics).map((name) => (
                <p className="ob-preview-item" key={name}>
                  <span>#</span>
                  <span>{name}</span>
                </p>
              ))}
            </PreviewSection>
            <PreviewSection title={t("ob.agents")} highlighted={stage === 2 || stage === 4}>
              <p className="ob-preview-item">
                <BotAvatar bot={guideBot} size={24} mood="idle" />
                <span>touri</span>
                <small>{t("ob.guide")}</small>
              </p>
              {bots
                .filter((bot) => bot.name !== "touri")
                .slice(0, 20)
                .map((bot) => (
                  <p className="ob-preview-item" key={bot.id}>
                    <BotAvatar bot={bot} size={24} mood={getPreviewMood(bot, progress, error)} />
                    <span>{bot.name}</span>
                  </p>
                ))}
              {!bots.length && <div className="ob-placeholder" />}
            </PreviewSection>
            <PreviewSection title={t("ob.computer")} highlighted={stage === 3}>
              {stage >= 3 ? (
                <p className="ob-preview-item">
                  <span>▭</span>
                  <span>{computer}</span>
                </p>
              ) : (
                <div className="ob-placeholder" />
              )}
            </PreviewSection>
            <PreviewSection title={t("ob.people")} highlighted={stage === 5}>
              <p className="ob-preview-item">{t(team ? "ob.invitedTeam" : "ob.you")}</p>
            </PreviewSection>
            {task && (
              <PreviewSection title={t("ob.firstTask")} highlighted={stage === 6}>
                <p className="ob-preview-item ob-preview-task">{task}</p>
              </PreviewSection>
            )}
          </div>
        </aside>
      </div>
    </main>
  )
}
const PreviewSection = ({
  title,
  highlighted,
  children,
}: {
  title: string
  highlighted: boolean
  children: ReactNode
}) => (
  <section className="ob-preview-section" data-highlighted={highlighted}>
    <h2>{title}</h2>
    {children}
  </section>
)
const getSegmentState = (index: number, stage: number): string => {
  if (index < stage) return "done"
  if (index === stage) return "current"
  return "next"
}
const questions: Record<GuideStep, { title: TranslationKey; detail: TranslationKey }> = {
  workspace: { title: "ob.workspaceQuestion", detail: "ob.workspaceDetail" },
  context: { title: "ob.contextQuestion", detail: "ob.contextDetail" },
  sources: { title: "ob.sourcesQuestion", detail: "ob.sourcesDetail" },
  manual: { title: "ob.manualQuestion", detail: "ob.manualDetail" },
  review: { title: "ob.reviewQuestion", detail: "ob.reviewDetail" },
  importing: { title: "ob.importQuestion", detail: "ob.importDetail" },
  computer: { title: "ob.computerQuestion", detail: "ob.computerDetail" },
  agents: { title: "ob.agentsQuestion", detail: "ob.agentsDetail" },
  team: { title: "ob.teamQuestion", detail: "ob.teamDetail" },
  task: { title: "ob.taskQuestion", detail: "ob.taskDetail" },
  ready: { title: "ob.readyQuestion", detail: "ob.readyDetail" },
}

const getPreviewMood = (
  bot: { name: string; agentKey?: string },
  progress: AgentImportProgress[],
  error: string | null,
): AvatarMood => {
  const current = progress.find((item) => item.agentKey === (bot.agentKey ?? bot.name))
  if (current?.step === "failed" || (error && bot.agentKey)) return "failed"
  if (current && current.step !== "done") return "working"
  return "idle"
}
