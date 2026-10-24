import type { AppSettings, Bot, Run, Thread } from "@touri/contracts"
import { type FormEvent, useEffect, useState } from "react"
import { BotAvatar } from "../../components/BotAvatar"
import { Button } from "../../components/Button"
import { ScreenHeader } from "../../components/ScreenPrimitives"
import { type TranslationKey, t } from "../../i18n"
import { getSidebarThreadTitle } from "../../sidebarThreadTitle"
import { getOngoingWorkRuns, getPrecedingWorkRun, getWorkStateLabel } from "./presentation"
import "../../components/screens.css"
import "./work.css"

export const WorkScreen = ({
  runs,
  bots,
  threads,
  loading,
  onThread,
  onStop,
}: {
  runs: Run[]
  bots: Bot[]
  threads: Thread[]
  loading: boolean
  onThread: (id: string) => void
  onStop?: (id: string) => Promise<void>
}) => {
  const [now, setNow] = useState(Date.now)
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [stopFailed, setStopFailed] = useState(false)
  const stop = async (runId: string): Promise<void> => {
    if (!onStop || stoppingRunId) return

    setStoppingRunId(runId)
    setStopFailed(false)
    try {
      await onStop(runId)
    } catch {
      setStopFailed(true)
    } finally {
      setStoppingRunId(null)
    }
  }
  useEffect(() => {
    if (runs.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runs.length])
  const running = runs.filter((run) => run.status === "starting" || run.status === "running")
  const ongoing = getOngoingWorkRuns(running)
  // Sort a fresh filtered array; the workspace snapshot stays untouched.
  const queued = runs
    .filter((run) => run.status === "queued")
    .sort(
      (first, second) =>
        (first.queuePosition ?? Number.MAX_SAFE_INTEGER) - (second.queuePosition ?? Number.MAX_SAFE_INTEGER),
    )

  return (
    <section className="workspace-screen r8-screen work-screen" aria-labelledby="work-title">
      <ScreenHeader id="work-title" title={t("Work")} description={t("Work description")} />
      <div className="screen-content">
        {stopFailed && <p role="alert">{t("Work stop error")}</p>}
        {loading && <p role="status">{t("Work loading")}</p>}
        {!loading && runs.length === 0 && <p className="screen-card">{t("Work empty")}</p>}
        <div className="work-columns">
          {[
            { label: t("Working"), entries: running },
            { label: t("Work queued"), entries: queued },
          ].map(({ label, entries }) => (
            <section className="work-column" key={label} aria-label={label}>
              <h2>
                {label} <span>{entries.length}</span>
              </h2>
              {entries.map((run) => {
                const bot = bots.find((bot) => bot.id === run.botId)
                const threadId = run.groupThreadId ?? run.threadId
                const thread = threads.find((thread) => thread.id === threadId)
                const preceding = getPrecedingWorkRun(run, ongoing)

                return (
                  <article
                    className="screen-card work-card"
                    key={run.id}
                    data-run-id={run.id}
                    id={`work-task-${run.id}`}
                    tabIndex={-1}
                  >
                    <div className="work-card-bot">
                      {bot && <BotAvatar bot={bot} size={28} />}
                      <strong>{bot?.name ?? t("Bot local")}</strong>
                    </div>
                    <button type="button" className="work-thread" disabled={!thread} onClick={() => onThread(threadId)}>
                      {thread ? getSidebarThreadTitle(thread) : t("Work conversation unavailable")}
                    </button>
                    <dl>
                      <div>
                        <dt>{t("Work origin")}</dt>
                        <dd>{getOriginLabel(run)}</dd>
                      </div>
                      <div>
                        <dt>{t("Work state")}</dt>
                        <dd>{getWorkStateLabel(run)}</dd>
                      </div>
                      <div>
                        <dt>{t(run.status === "queued" ? "Work waiting time" : "Work elapsed time")}</dt>
                        <dd>{getElapsedLabel(run, now)}</dd>
                      </div>
                    </dl>
                    {preceding && (
                      <button
                        type="button"
                        className="work-thread work-previous"
                        aria-controls={`work-task-${preceding.id}`}
                        onClick={() => document.getElementById(`work-task-${preceding.id}`)?.focus()}
                      >
                        {t("Work preceding task", { name: bot?.name ?? t("Bot local") })}
                      </button>
                    )}
                    {onStop && bot?.machine !== "cloud" && (
                      <Button
                        variant="secondary"
                        className="work-stop"
                        disabled={stoppingRunId !== null}
                        onClick={() => void stop(run.id)}
                      >
                        {t(getStopLabel(run, stoppingRunId))}
                      </Button>
                    )}
                  </article>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}

export const PerformanceScreen = ({
  settings,
  onSave,
}: {
  settings: AppSettings | null
  onSave: (patch: Partial<AppSettings>) => Promise<void>
}) => {
  const [limit, setLimit] = useState(settings?.maxConcurrentRuns ?? 3)
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  useEffect(() => {
    setLimit(settings?.maxConcurrentRuns ?? 3)
  }, [settings?.maxConcurrentRuns])
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) return
    setStatus("saving")
    try {
      await onSave({ maxConcurrentRuns: limit })
      setStatus("saved")
    } catch {
      setStatus("error")
    }
  }

  return (
    <section className="workspace-screen r8-screen work-screen" aria-labelledby="performance-title">
      <ScreenHeader id="performance-title" title={t("Performance")} description={t("Work performance description")} />
      <div className="screen-content">
        <form className="screen-card performance-form" onSubmit={(event) => void save(event)}>
          <label htmlFor="work-concurrency">{t("Work concurrency")}</label>
          <p id="work-concurrency-help">{t("Work concurrency help")}</p>
          <input
            id="work-concurrency"
            type="number"
            min={1}
            max={32}
            step={1}
            required
            value={limit}
            aria-describedby="work-concurrency-help"
            disabled={!settings || status === "saving"}
            onChange={(event) => {
              setLimit(Number(event.target.value))
              setStatus("idle")
            }}
          />
          <p>{t("Work concurrency changes")}</p>
          <button type="submit" className="brand-button" disabled={!settings || status === "saving"}>
            {t(status === "saving" ? "Work saving" : "Work save")}
          </button>
          {status === "saved" && <p role="status">{t("Work settings saved")}</p>}
          {status === "error" && <p role="alert">{t("Work settings error")}</p>}
        </form>
      </div>
    </section>
  )
}

const getOriginLabel = (run: Run): string => {
  const labels: Record<NonNullable<Run["origin"]>, TranslationKey> = {
    message: "Work message",
    routine: "Work routine",
    delegation: "Work delegation",
    resume: "Work resume",
  }
  const origin = run.origin ?? (run.trigger === "routine" ? "routine" : "message")

  return t(labels[origin])
}

const getElapsedLabel = (run: Run, now: number): string => {
  const started = run.status === "queued" ? run.queuedAt : (run.startedAt ?? run.queuedAt)
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  if (seconds < 60) return t("Work seconds", { count: seconds })

  return t("Work minutes", { count: Math.floor(seconds / 60), seconds: seconds % 60 })
}

const getStopLabel = (run: Run, stoppingRunId: string | null): TranslationKey => {
  if (run.id === stoppingRunId) return "Work stopping"
  if (run.status === "queued") return "Work cancel request"

  return "Work stop task"
}
