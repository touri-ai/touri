import type { Bot, BotGroup, HostKind, Id, Message, Routine, RoutineRun } from "@touri/contracts"
import { AVATAR_COLOR_CHOICES, avatarColorFor } from "@touri/contracts/avatar"
import { useEffect, useMemo, useRef, useState } from "react"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { userFacingError } from "../errors"
import { getRoutineRunDateLabel, getRoutineSkipSummary, t } from "../i18n"
import { draftFromRoutine, newRoutineDraft } from "../routineDraft"
import type { WorkspaceActions } from "../useWorkspace"
import type { RoutineHistoryTarget } from "../workspaceState"
import { BotAvatar } from "./BotAvatar"
import { DeleteRoutineDialog } from "./DeleteRoutineDialog"
import { Disclosure } from "./Disclosure"
import { PanelIcon } from "./PanelIcon"
import { RoutineEditor, routineHostNotice } from "./RoutineEditor"
import { RoutineSchedule } from "./RoutineSchedule"
import { ScreenHeader, ScreenState } from "./ScreenPrimitives"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import "./screens.css"

type CronScreenProps = {
  host?: HostKind
  initialBotFilter?: Id | undefined
  history?: RoutineHistoryTarget | undefined
  loading?: boolean
  loadError?: string | null
  selectedBotId: Id | null
  groups?: Array<BotGroup>
  bots: Array<Bot>
  routines: Array<Routine>
  routineRuns: Array<RoutineRun>
  messages: Array<Message>
  actions: WorkspaceActions
  onReviewApprovals: (target: ApprovalTarget) => void
  onNotice: (message: string) => void
  onOpenThread?: (threadId: Id) => void
}

type RoutineEditorState = { routine: Routine | null; botId: Id; isNew: boolean } | null
const HISTORY_PAGE_SIZE = 50

const getRoutineDayKey = (timestamp: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp)
  const year = parts.find((part) => part.type === "year")?.value ?? "0000"
  const month = parts.find((part) => part.type === "month")?.value ?? "00"
  const day = parts.find((part) => part.type === "day")?.value ?? "00"

  return `${year}-${month}-${day}`
}

const getRoutineDayLabel = (timestamp: number, timeZone: string): string => {
  const todayKey = getRoutineDayKey(Date.now(), timeZone)
  const runDayKey = getRoutineDayKey(timestamp, timeZone)
  if (runDayKey === todayKey) return t("Hoje")

  const yesterdayKey = new Date(Date.parse(`${todayKey}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  if (runDayKey === yesterdayKey) return t("Ontem")

  return new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "full" }).format(timestamp)
}

const getRoutineState = (
  enabled: boolean,
  awaiting: boolean,
  busy: boolean,
  latestRun: RoutineRun | undefined,
): { label: string; tone: string } => {
  if (!enabled) return { label: t("Routine paused"), tone: "" }
  if (awaiting) return { label: t("Waiting for approval"), tone: "is-warning" }
  if (busy) return { label: t("Em execução"), tone: "is-info" }
  if (latestRun?.status === "failed") return { label: t("Falhou"), tone: "is-error" }
  if (latestRun?.status === "succeeded") return { label: t("Routine completed"), tone: "is-success" }

  return { label: t("Routine active"), tone: "is-success" }
}

export const calendarBotColors = (bots: Array<Bot>): Map<Id, string> => {
  const used = new Set<string>()
  const colors = new Map<Id, string>()
  for (const bot of [...bots].sort((a, b) => a.id.localeCompare(b.id))) {
    const own = avatarColorFor(bot)
    const color = !used.has(own)
      ? own
      : (AVATAR_COLOR_CHOICES.find((candidate) => !used.has(candidate.hex))?.hex ?? own)
    colors.set(bot.id, color)
    used.add(color)
  }
  return colors
}

const CronScreen = ({
  bots,
  groups = [],
  host = "computer",
  initialBotFilter,
  history,
  loading = false,
  loadError = null,
  selectedBotId,
  routines,
  routineRuns,
  messages,
  actions,
  onNotice,
  onOpenThread,
}: CronScreenProps) => {
  const [actionRoutineId, setActionRoutineId] = useState<string | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const [historyOpen, setHistoryOpen] = useState(Boolean(history))
  const [historyFocusRequests, setHistoryFocusRequests] = useState(0)
  const historyStatus = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const focusList = () => {
      if (document.querySelector(".modal-card")) return false
      listRef.current?.focus()
      return true
    }
    if (focusList()) return
    // The settings dialog restores its trigger during exit; focus the destination afterwards.
    const observer = new MutationObserver(() => {
      if (focusList()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const startingRef = useRef(new Set<Id>())
  const [starting, setStarting] = useState<Set<Id>>(new Set())
  const runNow = async (routineId: Id): Promise<void> => {
    if (startingRef.current.has(routineId)) return
    startingRef.current.add(routineId)
    setStarting(new Set(startingRef.current))
    try {
      await actions.runRoutine(routineId)
    } catch (error) {
      onNotice(userFacingError(error))
    } finally {
      startingRef.current.delete(routineId)
      setStarting(new Set(startingRef.current))
    }
  }
  const historyBotFilter = bots.some((bot) => bot.id === initialBotFilter) ? (initialBotFilter ?? "all") : "all"
  const historyRoutineFilter = routines.some(
    (routine) =>
      routine.id === history?.routineId && (historyBotFilter === "all" || routine.botId === historyBotFilter),
  )
    ? (history?.routineId ?? "all")
    : "all"
  const [botFilter, setBotFilter] = useState<Id | "all">(historyBotFilter)
  const [stateFilter, setStateFilter] = useState<"all" | "active" | "paused">("all")
  const [routineFilter, setRoutineFilter] = useState<Id | "all">(historyRoutineFilter)
  const [historyPage, setHistoryPage] = useState(0)
  useEffect(() => {
    if (!history) return

    setBotFilter(historyBotFilter)
    setRoutineFilter(historyRoutineFilter)
    // A history destination explicitly opens the disclosure, then focuses its status once it is visible.
    setHistoryOpen(true)
    if (historyStatus.current?.closest("[hidden]")) setHistoryFocusRequests((count) => count + 1)
    else historyStatus.current?.focus()
    setHistoryPage(0)
  }, [history, historyBotFilter, historyRoutineFilter])
  useEffect(() => {
    if (historyFocusRequests > 0) historyStatus.current?.focus()
  }, [historyFocusRequests])

  const selectBotFilter = (botId: Id | "all") => {
    setBotFilter(botId)
    setRoutineFilter("all")
    setHistoryPage(0)
  }
  const selectStateFilter = (state: "all" | "active" | "paused") => {
    setStateFilter(state)
    setRoutineFilter("all")
    setHistoryPage(0)
  }
  const showHistoryPage = (page: number) => {
    setHistoryPage(page)
    historyStatus.current?.focus()
  }
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [deleting, setDeleting] = useState<Routine | null>(null)
  const [editor, setEditor] = useState<RoutineEditorState>(null)
  const pendingApprovals = useMemo(() => pendingApprovalTargets(messages), [messages])
  const visibleRoutines = routines.filter(
    (routine) =>
      (botFilter === "all" || routine.botId === botFilter) &&
      (stateFilter === "all" || (stateFilter === "active" ? routine.enabled : !routine.enabled)),
  )
  const visibleRoutineIds = new Set(visibleRoutines.map((routine) => routine.id))
  const historyRuns = routineRuns
    .filter(
      (run) => (routineFilter === "all" || run.routineId === routineFilter) && visibleRoutineIds.has(run.routineId),
    )
    // Only this filtered copy is sorted; the workspace history is shared with the sidebar.
    .sort((left, right) => right.scheduledFor - left.scheduledFor || right.id.localeCompare(left.id))
  const lastHistoryPage = Math.max(0, Math.ceil(historyRuns.length / HISTORY_PAGE_SIZE) - 1)
  const currentHistoryPage = Math.min(historyPage, lastHistoryPage)
  const historyOffset = currentHistoryPage * HISTORY_PAGE_SIZE
  const visibleHistoryRuns = historyRuns.slice(historyOffset, historyOffset + HISTORY_PAGE_SIZE)
  const calendar = useMemo(() => buildCalendar(month), [month])
  const calendarRuns = routineRuns.filter((routineRun) => {
    if (!visibleRoutines.some((routine) => routine.id === routineRun.routineId)) return false
    const date = new Date(routineRun.scheduledFor)
    return date.getFullYear() === month.getFullYear() && date.getMonth() === month.getMonth()
  })
  const colors = calendarBotColors(bots)
  const botById = new Map(bots.map((bot) => [bot.id, bot]))
  const runsByDate = new Map<number, Array<{ color: string; failed: boolean; key: string }>>()
  for (const routineRun of calendarRuns) {
    const routine = routines.find((candidate) => candidate.id === routineRun.routineId)
    if (!routine) continue
    const day = new Date(routineRun.scheduledFor).getDate()
    const existing = runsByDate.get(day) ?? []
    existing.push({
      color: colors.get(routine.botId) ?? "var(--text-tertiary)",
      failed: routineRun.status === "failed",
      key: routineRun.id,
    })
    runsByDate.set(day, existing)
  }

  return (
    <section
      ref={listRef}
      tabIndex={-1}
      className="workspace-screen r8-screen cron-screen"
      aria-labelledby="cron-title"
    >
      <ScreenHeader
        showBreadcrumb={false}
        id="cron-title"
        title={t("Routines")}
        description={`${t("Bot routine count", { count: routines.length })} · ${routineHostNotice(host)}`}
        actions={
          <button
            type="button"
            className="brand-button"
            disabled={bots.length === 0}
            onClick={() =>
              setEditor({
                routine: null,
                botId: botFilter !== "all" ? botFilter : (selectedBotId ?? bots[0]?.id ?? ""),
                isNew: true,
              })
            }
          >
            <PanelIcon name="plus" />
            {t("Criar cron")}
          </button>
        }
      />
      <fieldset className="cron-filters">
        <legend className="visually-hidden">{t("Filtros de cron")}</legend>
        <label>
          {t("Bot")}
          <select value={botFilter} onChange={(event) => selectBotFilter(event.target.value)}>
            <option value="all">{t("Todos os bots")}</option>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("estado")}
          <select
            value={stateFilter}
            onChange={(event) => selectStateFilter(event.target.value as "all" | "active" | "paused")}
          >
            <option value="all">{t("Todos")}</option>
            <option value="active">{t("Active routines")}</option>
            <option value="paused">{t("Paused routines")}</option>
          </select>
        </label>
      </fieldset>
      <div className="cron-content">
        <div className="cron-primary">
          <section className="cron-card routine-queue">
            <div className="cron-card-heading">
              <strong>Rotinas</strong>
              <span>{t("Visible count", { count: visibleRoutines.length })}</span>
            </div>
            <div className="routine-list">
              {loading ? (
                <ScreenState kind="loading" />
              ) : loadError ? (
                <ScreenState
                  kind="error"
                  description="As rotinas estão indisponíveis."
                  onRetry={() => void actions.refresh()}
                />
              ) : (
                visibleRoutines.map((routine) => {
                  const bot = botById.get(routine.botId)
                  const busy =
                    starting.has(routine.id) ||
                    routineRuns.some((run) => run.routineId === routine.id && run.status === "running")
                  const latestRun = [...routineRuns]
                    .filter((run) => run.routineId === routine.id)
                    .sort((a, b) => b.scheduledFor - a.scheduledFor)[0]
                  const awaiting =
                    latestRun?.status === "running" &&
                    pendingApprovals.some((target) => target.threadId === latestRun.threadId)
                  const state = getRoutineState(routine.enabled, awaiting, busy, latestRun)
                  return (
                    <article className={`routine-item ${routine.enabled ? "" : "is-paused"}`} key={routine.id}>
                      <BotAvatar bot={bot ?? { id: routine.botId, color: null }} size={32} />
                      <span className="routine-copy">
                        <strong>{routine.name}</strong>
                        <small>{bot?.name ?? "bot"}</small>
                        <RoutineSchedule routine={routine} />
                      </span>
                      <span className="routine-status">
                        <span className={`screen-status ${state.tone}`}>{state.label}</span>
                        <small>
                          {routine.enabled && routine.nextRunAt
                            ? `Próxima: ${formatNextRun(routine.nextRunAt)}`
                            : "Sem próxima execução"}
                        </small>
                      </span>
                      <fieldset
                        className="routine-actions"
                        aria-label={t("Ações da rotina {name}", { name: routine.name })}
                      >
                        <SidebarActionsMenu
                          label={t("Ações da rotina {name}", { name: routine.name })}
                          triggerClassName="outline-button"
                          open={actionRoutineId === routine.id}
                          onOpenChange={(open) => setActionRoutineId(open ? routine.id : null)}
                          actions={[
                            { label: t("Run now"), disabled: busy, onSelect: () => void runNow(routine.id) },
                            {
                              label: t(routine.enabled ? "Goal pause" : "Goal resume"),
                              onSelect: () => {
                                if (!routine.enabled) {
                                  setEditor({ routine, botId: routine.botId, isNew: false })
                                  return
                                }
                                void actions
                                  .toggleRoutine(routine)
                                  .catch((error: unknown) => onNotice(userFacingError(error)))
                              },
                            },
                            {
                              label: t("Editar"),
                              onSelect: () => setEditor({ routine, botId: routine.botId, isNew: false }),
                            },
                            { label: t("Excluir rotina"), destructive: true, onSelect: () => setDeleting(routine) },
                          ]}
                        />
                      </fieldset>
                    </article>
                  )
                })
              )}
              {!loading && !loadError && visibleRoutines.length === 0 && (
                <ScreenState
                  kind="empty"
                  title={
                    routines.length === 0
                      ? "Sua primeira rotina começa aqui"
                      : "Nenhuma rotina corresponde a estes filtros"
                  }
                  description={
                    routines.length === 0
                      ? "Agende uma tarefa para um bot. Novas rotinas começam pausadas."
                      : "Escolha outro bot ou estado para ver mais rotinas."
                  }
                />
              )}
            </div>
            <Disclosure
              className="routine-run-history"
              open={historyOpen}
              onOpenChange={setHistoryOpen}
              summary={t("Histórico de execuções")}
            >
              <label className="routine-history-filter">
                {t("Routine history filter")}
                <select
                  value={routineFilter}
                  onChange={(event) => {
                    setRoutineFilter(event.currentTarget.value)
                    setHistoryPage(0)
                  }}
                >
                  <option value="all">{t("All routines")}</option>
                  {visibleRoutines.map((routine) => (
                    <option key={routine.id} value={routine.id}>
                      {botById.get(routine.botId)?.name} · {routine.name}
                    </option>
                  ))}
                </select>
              </label>
              <p role="status" ref={historyStatus} tabIndex={-1}>
                {t("Routine history range", {
                  from: historyRuns.length ? historyOffset + 1 : 0,
                  to: historyOffset + visibleHistoryRuns.length,
                  total: historyRuns.length,
                })}
              </p>
              <ul className="routine-history-list">
                {visibleHistoryRuns.map((run, index) => {
                  const routine = routines.find((routine) => routine.id === run.routineId)
                  const threadId = run.threadId
                  const timeZone = routine?.timezone ?? "UTC"
                  const dayKey = getRoutineDayKey(run.scheduledFor, timeZone)
                  const previousRun = visibleHistoryRuns[index - 1]
                  const previousRoutine = previousRun
                    ? routines.find((item) => item.id === previousRun.routineId)
                    : undefined
                  const isNewDay =
                    !previousRun ||
                    dayKey !== getRoutineDayKey(previousRun.scheduledFor, previousRoutine?.timezone ?? "UTC")
                  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

                  return (
                    <li key={run.id}>
                      {isNewDay && (
                        <h3 className="routine-history-day">{getRoutineDayLabel(run.scheduledFor, timeZone)}</h3>
                      )}
                      <div className="routine-history-run">
                        <span className="routine-history-copy">
                          <strong>{routine?.name}</strong>
                          <time dateTime={new Date(run.scheduledFor).toISOString()}>
                            {getRoutineRunDateLabel(run.scheduledFor, "pt-BR", timeZone)}
                          </time>
                          {routine?.timezone !== userTimeZone && routine?.timezone && <small>{routine.timezone}</small>}
                        </span>
                        <span className={`routine-history-status routine-history-status-${run.status}`}>
                          {t(run.status)}
                        </span>
                        {threadId && onOpenThread ? (
                          <button type="button" className="outline-button" onClick={() => onOpenThread(threadId)}>
                            {t("Open routine conversation")}
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                      {run.status === "skipped" && (
                        <p className="routine-history-note">
                          {getRoutineSkipSummary(run.summary ?? "") ??
                            t("Disparo não executado: touri indisponível ou execução anterior em andamento.")}
                        </p>
                      )}
                      {run.triggerSource === "catch-up" && (
                        <p className="routine-history-note">{t("Execução de recuperação")}</p>
                      )}
                    </li>
                  )
                })}
              </ul>
              <div className="routine-history-actions">
                {currentHistoryPage > 0 && (
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => showHistoryPage(currentHistoryPage - 1)}
                  >
                    {t("Previous routine runs page")}
                  </button>
                )}
                {currentHistoryPage < lastHistoryPage && (
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => showHistoryPage(currentHistoryPage + 1)}
                  >
                    {t("Next routine runs page")}
                  </button>
                )}
              </div>
            </Disclosure>
          </section>
        </div>
        <section className="cron-card calendar-card" aria-label={t("Calendário mensal")}>
          <div className="calendar-heading">
            <strong>{t("Calendário mensal")}</strong>
            <span>
              <button
                type="button"
                aria-label={t("Mês anterior")}
                onClick={() => setMonth((value) => shiftMonth(value, -1))}
              >
                <PanelIcon name="chevron-left" />
              </button>
              <span>{month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</span>
              <button
                type="button"
                aria-label={t("Próximo mês")}
                onClick={() => setMonth((value) => shiftMonth(value, 1))}
              >
                <PanelIcon name="chevron-right" />
              </button>
            </span>
          </div>
          <div className="calendar-weekdays">
            {["dom", "seg", "ter", "qua", "qui", "sex", "sáb"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {calendar.map((day) => {
              const dots = day.number ? (runsByDate.get(day.number) ?? []) : []
              return (
                <div
                  className={`calendar-day ${day.inMonth ? "" : "outside"} ${day.today ? "today" : ""}`}
                  key={day.key}
                >
                  <span>{day.number || ""}</span>
                  <span className="calendar-dots">
                    {dots.slice(0, 4).map((dot) => (
                      <i
                        data-run-id={dot.key}
                        className={dot.failed ? "failed" : ""}
                        style={{ background: dot.failed ? "var(--text-danger)" : dot.color }}
                        key={dot.key}
                      />
                    ))}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="calendar-legend">
            {bots
              .filter((bot) => visibleRoutines.some((routine) => routine.botId === bot.id))
              .map((bot) => (
                <span key={bot.id}>
                  <i style={{ background: colors.get(bot.id) }} />
                  {bot.name}
                </span>
              ))}
            <span>
              <i className="failed" />
              {t("falhou")}
            </span>
          </div>
        </section>
      </div>
      {deleting && (
        <DeleteRoutineDialog
          routine={deleting}
          onDelete={actions.deleteRoutine}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const heading = document.getElementById("cron-title")
            heading?.setAttribute("tabindex", "-1")
            heading?.focus()
          }}
        />
      )}
      {editor && (
        <RoutineEditor
          initial={editor.routine ? draftFromRoutine(editor.routine) : newRoutineDraft(editor.botId)}
          routineId={editor.routine?.id}
          bots={bots}
          groups={groups}
          host={host}
          actions={actions}
          onClose={() => {
            setEditor(null)
            const heading = document.getElementById("cron-title")
            heading?.setAttribute("tabindex", "-1")
            heading?.focus()
          }}
        />
      )}
    </section>
  )
}

const formatNextRun = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })

const shiftMonth = (date: Date, amount: number): Date => new Date(date.getFullYear(), date.getMonth() + amount, 1)

const buildCalendar = (month: Date): Array<{ key: string; number: number; inMonth: boolean; today: boolean }> => {
  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay()
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const today = new Date()
  return Array.from({ length: Math.ceil((firstWeekday + daysInMonth) / 7) * 7 }, (_, index) => {
    const number = index - firstWeekday + 1
    return {
      key:
        number <= 0 ? `leading-${number}` : number > daysInMonth ? `trailing-${number - daysInMonth}` : `day-${number}`,
      number: number > 0 && number <= daysInMonth ? number : 0,
      inMonth: number > 0 && number <= daysInMonth,
      today:
        number === today.getDate() &&
        month.getMonth() === today.getMonth() &&
        month.getFullYear() === today.getFullYear(),
    }
  })
}

export default CronScreen
