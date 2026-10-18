import type { Bot, Goal, GoalControl, Id, Message } from "@touri/contracts"
import { type FormEvent, useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { type TranslationKey, t } from "../i18n"
import { ChatDisclosure } from "./ChatDisclosure"
import "./goal-panel.css"

export const GoalPanel = ({
  api,
  threadId,
  bot,
  request,
  busy,
}: {
  api: UiApi
  threadId: Id
  bot: Bot
  request: Message | undefined
  busy: boolean
}) => {
  const [goal, setGoal] = useState<Goal | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [criterion, setCriterion] = useState("")
  const [turns, setTurns] = useState(4)
  const [minutes, setMinutes] = useState(15)
  const [now, setNow] = useState(Date.now)
  const id = useId()
  const hasScope = bot.machine === "local" && !!(bot.projectId || bot.folders?.length || bot.anyFolderAccess)

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const response = await api.request("GET /threads/:id/goal", {}, { id: threadId })
        if (!alive) return
        setGoal((current) =>
          current && response.goal && current.updatedAt > response.goal.updatedAt ? current : response.goal,
        )
        setLoaded(true)
        setLoadFailed(false)
        setNow(Date.now())
      } catch {
        if (alive) setLoadFailed(true)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)

    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [api, threadId])

  const control = async (input: GoalControl) => {
    setPending(true)
    setFailed(false)
    try {
      const response = await api.request("PATCH /threads/:id/goal", input, { id: threadId })
      setGoal(response.goal)
      setNow(Date.now())
      setEditing(false)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const start = async (event: FormEvent) => {
    event.preventDefault()
    if (!request || !loaded || !hasScope || busy || pending) return
    setPending(true)
    setFailed(false)
    try {
      const response = await api.request(
        "POST /threads/:id/goal",
        { requestMessageId: request.id, completionCriterion: criterion, maxTurns: turns, maxMinutes: minutes },
        { id: threadId },
      )
      setGoal(response.goal)
      setNow(Date.now())
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  const budgetFields = (
    <div className="goal-budget-fields">
      <label htmlFor={`${id}-turns`}>
        {t("Goal turn limit")}
        <input
          id={`${id}-turns`}
          type="number"
          min="1"
          max="20"
          required
          value={turns}
          onChange={(event) => setTurns(Number(event.target.value))}
        />
      </label>
      <label htmlFor={`${id}-minutes`}>
        {t("Goal minutes")}
        <input
          id={`${id}-minutes`}
          type="number"
          min="1"
          max="240"
          required
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
    </div>
  )

  return (
    <section className="goal-panel" aria-label={t("Continue until done")}>
      {goal && (
        <div className="goal-checkpoint">
          <div className="goal-heading">
            <strong>{t("Continue until done")}</strong>
            <span role="status">{t(getStatusKey(goal.status))}</span>
          </div>
          <p className="goal-criterion">{goal.completionCriterion}</p>
          <p>
            {t("Goal remaining", {
              turns: Math.max(0, goal.maxTurns - goal.turnsUsed),
              minutes: Math.max(0, Math.ceil((goal.deadlineAt - now) / 60_000)),
            })}
          </p>
          <p className="goal-last-step">{goal.steps.at(-1)?.text ?? t("Goal waiting for checkpoint")}</p>
          {goal.status === "budget_exhausted" && <p>{t("Goal budget exhausted help")}</p>}
          {goal.status !== "completed" && (
            <div className="goal-actions">
              <button
                className="button button-quiet"
                type="button"
                disabled={pending || (goal.status !== "active" && busy)}
                onClick={() => void control({ action: goal.status === "active" ? "pause" : "resume" })}
              >
                {t(goal.status === "active" ? "Goal pause" : "Goal resume")}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={pending}
                onClick={() => void control({ action: "complete" })}
              >
                {t("Complete goal now")}
              </button>
              <button
                className="button button-quiet"
                type="button"
                disabled={pending}
                aria-expanded={editing}
                onClick={() => {
                  setTurns(goal.maxTurns)
                  setMinutes(Math.max(1, Math.ceil((goal.deadlineAt - Date.now()) / 60_000)))
                  setEditing(!editing)
                }}
              >
                {t("Change goal budget")}
              </button>
            </div>
          )}
          {editing && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void control({ action: "budget", maxTurns: turns, maxMinutes: minutes })
              }}
            >
              {budgetFields}
              <p>{t("Goal budget edit help")}</p>
              <button className="button button-quiet" type="submit" disabled={pending}>
                {t("Save goal budget")}
              </button>
            </form>
          )}
        </div>
      )}
      {(!goal || goal.status === "completed") && (
        <ChatDisclosure label={t("Goal advanced")} expanded={advanced} onExpandedChange={setAdvanced}>
          {advanced && (
            <>
              <p>{t("Goal mode help")}</p>
              {!hasScope && <p>{t(bot.machine === "local" ? "Goal folder required" : "Goal local only")}</p>}
              <form onSubmit={(event) => void start(event)}>
                <label htmlFor={`${id}-criterion`}>{t("Goal completion criterion")}</label>
                <textarea
                  id={`${id}-criterion`}
                  required
                  maxLength={2000}
                  value={criterion}
                  onChange={(event) => setCriterion(event.target.value)}
                />
                {budgetFields}
                <button
                  className="button button-quiet"
                  type="submit"
                  disabled={!loaded || pending || !hasScope || !request || busy}
                >
                  {t("Continue until done")}
                </button>
                {busy && <p>{t("Goal wait for turn")}</p>}
              </form>
            </>
          )}
        </ChatDisclosure>
      )}
      {(failed || loadFailed) && <p role="alert">{t("Goal request failed")}</p>}
    </section>
  )
}

const getStatusKey = (status: Goal["status"]): TranslationKey => {
  const labels: Record<Goal["status"], TranslationKey> = {
    active: "Goal active",
    paused: "Goal paused",
    budget_exhausted: "Goal budget exhausted",
    completed: "Goal completed",
  }
  return labels[status]
}
