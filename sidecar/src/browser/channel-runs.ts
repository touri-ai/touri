import type { Database } from "bun:sqlite"
import type { BrowserChannelRun, BrowserChannelRunStatus, Id, Kernel, ToolContext } from "@touri/contracts"

const DEFAULT_NEEDS_YOU_ESCALATION_MS = 5 * 60_000
const MIN_NEEDS_YOU_ESCALATION_MS = 60_000
const MAX_NEEDS_YOU_ESCALATION_MS = 60 * 60_000
const MAX_QUEUED_BROWSER_RUNS = 20
const LIVE_STATUSES: Array<BrowserChannelRunStatus> = ["running", "needs_you", "taken_over"]
const VISIBLE_STATUSES: Array<BrowserChannelRunStatus> = ["queued", ...LIVE_STATUSES]

type QueueItem = { runId: string; channelId: string; botId: string; queuedAt: number }
type BrowserChannelRunRow = {
  run_id: string
  current_run_id: string
  resume_pending: number
  group_id: string | null
  thread_id: string
  bot_id: string
  requester_person_id: string | null
  responsible_person_id: string | null
  controller_person_id: string | null
  status: BrowserChannelRunStatus
  queue_position: number | null
  queued_at: number
  started_at: number | null
  needs_you_at: number | null
  escalated_at: number | null
  finished_at: number | null
}

export const getRequesterPersonId = (sender: { id?: unknown; kind?: unknown } | null | undefined): Id | null =>
  sender?.kind === "person" && typeof sender.id === "string" ? sender.id : null

export const canControlChannelBrowserRun = ({
  actorPersonId,
  requesterPersonId,
  responsiblePersonId,
}: {
  actorPersonId: string
  requesterPersonId: string | null
  responsiblePersonId: string | null
}): boolean => actorPersonId === requesterPersonId || actorPersonId === responsiblePersonId

export const getBrowserRunControlError = (controllerName: string | null): string =>
  controllerName
    ? `${controllerName} está no controle do navegador. Só quem pediu ou a pessoa responsável pelo bot pode alterar o controle.`
    : "Só quem pediu este trabalho ou a pessoa responsável pelo bot pode controlar este navegador."

export const getNeedsYouEscalationMs = (value: unknown): number => {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (
    !Number.isSafeInteger(parsed) ||
    Number(parsed) < MIN_NEEDS_YOU_ESCALATION_MS ||
    Number(parsed) > MAX_NEEDS_YOU_ESCALATION_MS
  )
    return DEFAULT_NEEDS_YOU_ESCALATION_MS

  return Number(parsed)
}

export const getNeedsYouRecipient = ({
  requesterPersonId,
  responsiblePersonId,
  needsYouAt,
  now,
  escalationMs,
}: {
  requesterPersonId: string | null
  responsiblePersonId: string | null
  needsYouAt: number
  now: number
  escalationMs: number
}): string | null => {
  if (now < needsYouAt + escalationMs) return requesterPersonId ?? responsiblePersonId
  if (responsiblePersonId && responsiblePersonId !== requesterPersonId) return responsiblePersonId

  return requesterPersonId ?? responsiblePersonId
}

export const getNextChannelBrowserRun = ({
  queued,
  active,
}: {
  queued: Array<QueueItem>
  active: ReadonlySet<string>
}): QueueItem | undefined =>
  queued
    .filter((item) => !active.has(item.botId))
    .slice()
    .sort((first, second) => first.queuedAt - second.queuedAt || first.runId.localeCompare(second.runId))[0]

const selectRunSql = `SELECT c.*,
  CASE WHEN c.status = 'queued' THEN 1 + (
    SELECT COUNT(*) FROM browser_channel_runs queued
    WHERE queued.bot_id = c.bot_id AND queued.status = 'queued'
      AND (queued.queued_at < c.queued_at OR (queued.queued_at = c.queued_at AND queued.run_id < c.run_id))
  ) ELSE NULL END AS queue_position
  FROM browser_channel_runs c`

export const createChannelBrowserRuns = ({
  kernel,
  database,
  escalationMs = getNeedsYouEscalationMs(process.env.TOURI_BROWSER_NEEDS_YOU_ESCALATION_MS),
  now = Date.now,
}: {
  kernel: Kernel
  database: Database
  escalationMs?: number
  now?: () => number
}) => {
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  const resumeTimers = new Map<Id, ReturnType<typeof setTimeout>>()
  const escalationTimers = new Map<Id, ReturnType<typeof setTimeout>>()
  const personName = (personId: string | null): string | null =>
    personId ? (kernel.services.use("work.personName")?.(personId) ?? null) : null
  const getRaw = (runId: string): BrowserChannelRunRow | null =>
    (database
      .query(
        `${selectRunSql} WHERE c.run_id = ? OR c.current_run_id = ? OR c.run_id = (SELECT original_run_id FROM browser_takeover_continuations WHERE run_id = ?)`,
      )
      .get(runId, runId, runId) as BrowserChannelRunRow | null) ?? null
  const toPublic = (row: BrowserChannelRunRow): BrowserChannelRun => ({
    runId: row.run_id,
    activeRunId: row.current_run_id,
    groupId: row.group_id ?? "",
    threadId: row.thread_id,
    botId: row.bot_id,
    requesterPersonId: row.requester_person_id,
    requesterName: personName(row.requester_person_id),
    responsiblePersonId: row.responsible_person_id,
    controllerPersonId: row.controller_person_id,
    controllerName: personName(row.controller_person_id),
    status: row.status,
    queuePosition: row.queue_position,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    needsYouAt: row.needs_you_at,
    escalatedAt: row.escalated_at,
    finishedAt: row.finished_at,
  })
  const get = (runId: string): BrowserChannelRun | null => {
    const row = getRaw(runId)
    return row ? toPublic(row) : null
  }
  const publish = (runId: string): void => {
    const run = get(runId)
    if (run?.groupId) kernel.publish({ type: "browser.channel_run", run })
  }
  const publishQueue = (_channelId: string, botId: string): void => {
    const rows = database
      .query(`${selectRunSql} WHERE c.bot_id = ? AND c.status = 'queued' AND c.group_id IS NOT NULL
        ORDER BY c.queued_at, c.run_id LIMIT ${MAX_QUEUED_BROWSER_RUNS}`)
      .all(botId) as BrowserChannelRunRow[]
    rows.forEach((row) => {
      kernel.publish({ type: "browser.channel_run", run: toPublic(row) })
    })
  }
  const list = (groupIds?: Array<string>): Array<BrowserChannelRun> => {
    if (groupIds && groupIds.length === 0) return []
    const scope = groupIds ? `AND c.group_id IN (${groupIds.map(() => "?").join(",")})` : ""
    const rows = database
      .query(`${selectRunSql} WHERE c.group_id IS NOT NULL AND c.status IN ('queued','running','needs_you','taken_over') ${scope}
        ORDER BY c.group_id, c.thread_id, c.bot_id, c.queued_at, c.run_id LIMIT 100`)
      .all(...(groupIds ?? [])) as BrowserChannelRunRow[]
    return rows.map(toPublic)
  }
  const getForTab = (tabId: string): BrowserChannelRun | null => {
    const row = database
      .query(`${selectRunSql}
        JOIN browser_tabs tab ON tab.owner_bot_id = c.bot_id
        JOIN threads owner_thread ON owner_thread.id = tab.owner_thread_id
        WHERE tab.id = ? AND COALESCE(owner_thread.group_thread_id, owner_thread.id) = c.thread_id
          AND c.status IN ('running','needs_you','taken_over') LIMIT 1`)
      .get(tabId) as BrowserChannelRunRow | null

    return row ? toPublic(row) : null
  }
  const getForRun = (runId: string): BrowserChannelRun | null => {
    const row = database
      .query(`${selectRunSql}
        LEFT JOIN group_run_links link ON link.run_id = c.run_id
        WHERE (c.run_id = ? OR link.turn_id = ?) AND c.status IN ('running','needs_you','taken_over')
        ORDER BY c.queued_at DESC LIMIT 1`)
      .get(runId, runId) as BrowserChannelRunRow | null
    return row ? toPublic(row) : null
  }
  const getContext = (ctx: ToolContext) => {
    if (!ctx.runId) return null
    return database
      .query(`SELECT t.group_id, t.group_thread_id, r.requester_person_id, b.responsible_person_id
        FROM runs r JOIN threads t ON t.id = r.thread_id JOIN bots b ON b.id = r.bot_id
        WHERE r.id = ? AND r.bot_id = ? LIMIT 1`)
      .get(ctx.runId, ctx.botId) as {
      group_id: string | null
      group_thread_id: string | null
      requester_person_id: string | null
      responsible_person_id: string | null
    } | null
  }
  const clearEscalation = (runId: string): void => {
    const timer = escalationTimers.get(runId)
    if (timer) clearTimeout(timer)
    escalationTimers.delete(runId)
  }
  const emitNeedsYou = (row: BrowserChannelRunRow, targetPersonId: string, escalated: boolean): void => {
    kernel.services.use("notify.emit")?.({
      kind: "takeover",
      botId: row.bot_id,
      threadId: row.thread_id,
      requestId: `browser-needs-you:${row.run_id}${escalated ? ":owner" : ""}`,
      targetPersonId,
      title: escalated ? "O navegador precisa de atenção" : "O navegador precisa de você",
      body: escalated
        ? "A pessoa que pediu ainda não assumiu o navegador. Você, responsável pelo bot, pode ajudar agora."
        : "O bot pausou o navegador e precisa que você assuma o controle para continuar.",
    })
  }
  const resolveNeedsYou = (runId: string): void => {
    kernel.services.use("notify.resolve")?.({ requestId: `browser-needs-you:${runId}`, resolution: "replied" })
    kernel.services.use("notify.resolve")?.({ requestId: `browser-needs-you:${runId}:owner`, resolution: "replied" })
  }
  const escalate = (runId: string): void => {
    const row = getRaw(runId)
    if (row?.status !== "needs_you") return
    if (
      row.controller_person_id ||
      row.escalated_at !== null ||
      !row.requester_person_id ||
      !row.responsible_person_id ||
      row.responsible_person_id === row.requester_person_id
    )
      return
    const targetPersonId = getNeedsYouRecipient({
      requesterPersonId: row.requester_person_id,
      responsiblePersonId: row.responsible_person_id,
      needsYouAt: row.needs_you_at ?? now(),
      now: now(),
      escalationMs,
    })
    if (!targetPersonId || targetPersonId === row.requester_person_id) return
    database
      .query("UPDATE browser_channel_runs SET escalated_at = ? WHERE run_id = ? AND escalated_at IS NULL")
      .run(now(), runId)
    const updated = getRaw(runId)
    if (!updated) return
    publish(runId)
    emitNeedsYou(updated, targetPersonId, true)
  }
  const scheduleEscalation = (runId: string): void => {
    clearEscalation(runId)
    const row = getRaw(runId)
    if (row?.status !== "needs_you") return
    if (row.controller_person_id || row.escalated_at !== null) return
    const dueAt = (row.needs_you_at ?? now()) + escalationMs
    const timer = setTimeout(
      () => {
        escalationTimers.delete(runId)
        escalate(runId)
      },
      Math.max(0, dueAt - now()),
    )
    escalationTimers.set(runId, timer)
  }
  const resumeRequest = (runId: string, attempt = 0): void => {
    const row = getRaw(runId)
    if (!row?.resume_pending || !LIVE_STATUSES.includes(row.status)) return
    const run = database.query("SELECT thread_id FROM runs WHERE id = ?").get(row.current_run_id) as {
      thread_id: string
    } | null
    if (!run) return
    const waiting = database
      .query("SELECT 1 FROM browser_pending_handoffs WHERE run_id IN (?,?) AND state = 'waiting' LIMIT 1")
      .get(row.current_run_id, row.run_id)
    if (!waiting)
      kernel.services.use("runtime.resumeAfterBrowserTakeover")?.({
        botId: row.bot_id,
        threadId: run.thread_id,
        runId: row.current_run_id,
      })
    if (attempt >= 30) return
    const previous = resumeTimers.get(runId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      resumeTimers.delete(runId)
      resumeRequest(runId, attempt + 1)
    }, 1000)
    timer.unref()
    resumeTimers.set(runId, timer)
  }

  const updateTerminal = (runId: string, status: "succeeded" | "failed" | "canceled"): void => {
    const changed = database
      .transaction(() => {
        const current = database
          .query("SELECT thread_id,group_id,bot_id,status FROM browser_channel_runs WHERE run_id = ?")
          .get(runId) as { thread_id: string; group_id: string; bot_id: string; status: BrowserChannelRunStatus } | null
        if (!current || !VISIBLE_STATUSES.includes(current.status)) return []
        database
          .query(
            "UPDATE browser_channel_runs SET status = ?, controller_person_id = NULL, finished_at = ? WHERE run_id = ?",
          )
          .run(status, now(), runId)
        if (!LIVE_STATUSES.includes(current.status)) return [runId]
        const queued = database
          .query(`SELECT run_id, bot_id, queued_at FROM browser_channel_runs
            WHERE bot_id = ? AND status = 'queued' ORDER BY queued_at, run_id LIMIT 20`)
          .all(current.bot_id) as Array<{
          run_id: string
          bot_id: string
          queued_at: number
        }>
        const next = getNextChannelBrowserRun({
          queued: queued.map((row) => ({
            runId: row.run_id,
            activeRunId: row.current_run_id,
            channelId: current.thread_id,
            botId: row.bot_id,
            queuedAt: row.queued_at,
          })),
          active: new Set(),
        })
        if (!next) return [runId]
        database
          .query(
            "UPDATE browser_channel_runs SET status = 'running', resume_pending = 1, started_at = ? WHERE run_id = ? AND status = 'queued'",
          )
          .run(now(), next.runId)
        return [runId, next.runId]
      })
      .immediate()
    if (changed.length === 0) return
    clearEscalation(runId)
    resolveNeedsYou(runId)
    changed.forEach(publish)
    if (changed[1]) resumeRequest(changed[1])
    const scope = database.query("SELECT thread_id, bot_id FROM browser_channel_runs WHERE run_id = ?").get(runId) as {
      thread_id: string
      bot_id: string
    } | null
    if (scope) publishQueue(scope.thread_id, scope.bot_id)
  }
  const cancelRequest = (
    runId: string,
    status: "failed" | "canceled" = "canceled",
  ): { runId: string; requestId: string; botId: string; ownsControl: boolean } | null => {
    const row =
      getRaw(runId) ??
      (database
        .query(`${selectRunSql}
      WHERE c.current_run_id IN (SELECT run_id FROM group_run_links WHERE turn_id = ?)
        AND c.status IN ('queued','running','needs_you','taken_over') LIMIT 1`)
        .get(runId) as BrowserChannelRunRow | null)
    if (!row || !VISIBLE_STATUSES.includes(row.status)) return null
    updateTerminal(row.run_id, status)
    return {
      runId: row.current_run_id,
      requestId: row.run_id,
      botId: row.bot_id,
      ownsControl: LIVE_STATUSES.includes(row.status),
    }
  }

  const enter = async (
    ctx: ToolContext,
  ): Promise<{ success: true; queued?: boolean } | { success: false; errorCode: string; error: string }> => {
    if (!ctx.runId || ctx.signal.aborted) return { success: true }
    if (!kernel.services.use("work.personChannelIds")) return { success: true }
    const context = getContext(ctx)
    if (!context) return { success: true }
    const continuation = database
      .query("SELECT original_run_id FROM browser_takeover_continuations WHERE run_id = ?")
      .get(ctx.runId) as { original_run_id: string } | null
    const runId = continuation?.original_run_id ?? ctx.runId
    const outcome = database
      .transaction(() => {
        const existing = database.query("SELECT status FROM browser_channel_runs WHERE run_id = ?").get(runId) as {
          status: BrowserChannelRunStatus
        } | null
        if (existing) {
          database
            .query(
              "UPDATE browser_channel_runs SET current_run_id = ?, resume_pending = CASE WHEN current_run_id != ? THEN 0 ELSE resume_pending END WHERE run_id = ?",
            )
            .run(ctx.runId, ctx.runId, runId)
          return { status: existing.status, inserted: false }
        }
        const active = database
          .query(`SELECT run_id FROM browser_channel_runs WHERE bot_id = ?
            AND status IN ('running','needs_you','taken_over') LIMIT 1`)
          .get(ctx.botId)
        const queuedCount = (
          database
            .query("SELECT COUNT(*) AS count FROM browser_channel_runs WHERE bot_id = ? AND status = 'queued'")
            .get(ctx.botId) as { count: number }
        ).count
        if (active && queuedCount >= MAX_QUEUED_BROWSER_RUNS) return { status: null, inserted: false }
        const status: BrowserChannelRunStatus = active ? "queued" : "running"
        const lastQueuedAt = active
          ? ((
              database
                .query(
                  "SELECT MAX(queued_at) AS queued_at FROM browser_channel_runs WHERE bot_id = ? AND status = 'queued'",
                )
                .get(ctx.botId) as { queued_at: number | null }
            ).queued_at ?? -1)
          : -1
        const queuedAt = Math.max(now(), lastQueuedAt + 1)
        database
          .query(`INSERT INTO browser_channel_runs
            (run_id,current_run_id,group_id,thread_id,bot_id,requester_person_id,responsible_person_id,status,queued_at,started_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(
            runId,
            ctx.runId,
            context.group_id,
            context.group_thread_id ?? ctx.threadId,
            ctx.botId,
            context.requester_person_id,
            context.responsible_person_id ?? kernel.services.use("work.defaultPersonId")?.() ?? null,
            status,
            queuedAt,
            status === "running" ? now() : null,
          )
        return { status, inserted: true }
      })
      .immediate()
    if (outcome.status === null)
      return {
        success: false,
        errorCode: "BROWSER_QUEUE_FULL",
        error: "A fila deste navegador está cheia. Tente de novo em instantes.",
      }
    if (outcome.inserted) publish(runId)
    if (outcome.status === "running") return { success: true }
    if (outcome.status !== "queued" && outcome.status !== "needs_you" && outcome.status !== "taken_over")
      return { success: false, errorCode: "BROWSER_RUN_FINISHED", error: "Este turno do navegador já foi encerrado." }
    return { success: true, queued: true }
  }

  const needsYou = (currentRunId: string | null, reason: string): boolean => {
    if (!currentRunId) return false
    const row = getRaw(currentRunId)
    if (!row || !["running", "needs_you"].includes(row.status)) return false
    const runId = row.run_id
    if (row.status === "running")
      database
        .query("UPDATE browser_channel_runs SET status = 'needs_you', needs_you_at = ? WHERE run_id = ?")
        .run(now(), runId)
    const updated = getRaw(runId)
    if (!updated) return false
    publish(runId)
    const firstRecipient = getNeedsYouRecipient({
      requesterPersonId: updated.requester_person_id,
      responsiblePersonId: updated.responsible_person_id,
      needsYouAt: updated.needs_you_at ?? now(),
      now: now(),
      escalationMs,
    })
    if (firstRecipient) {
      kernel.services.use("notify.emit")?.({
        kind: "takeover",
        botId: updated.bot_id,
        threadId: updated.thread_id,
        requestId: `browser-needs-you:${runId}`,
        targetPersonId: firstRecipient,
        title: "O navegador precisa de você",
        body: `O bot pausou o navegador e precisa de ajuda: ${kernel.redact(reason).slice(0, 300)}`,
      })
    }
    scheduleEscalation(runId)
    return true
  }
  const takeControl = ({
    runId,
    actorPersonId,
  }: {
    runId: string
    actorPersonId: string
  }): { success: true } | { success: false; error: string } => {
    const row = getRaw(runId)
    if (!row || !LIVE_STATUSES.includes(row.status))
      return { success: false, error: "Este navegador não está mais ativo." }
    const controllerName = personName(row.controller_person_id)
    if (
      !canControlChannelBrowserRun({
        actorPersonId,
        requesterPersonId: row.requester_person_id,
        responsiblePersonId: row.responsible_person_id,
      })
    )
      return { success: false, error: getBrowserRunControlError(controllerName) }
    if (row.controller_person_id && row.controller_person_id !== actorPersonId)
      return { success: false, error: getBrowserRunControlError(controllerName) }
    database
      .query("UPDATE browser_channel_runs SET status = 'taken_over', controller_person_id = ? WHERE run_id = ?")
      .run(actorPersonId, runId)
    clearEscalation(runId)
    resolveNeedsYou(runId)
    publish(runId)
    return { success: true }
  }
  const restoreControl = ({
    runId,
    actorPersonId,
    status,
  }: {
    runId: string
    actorPersonId: string
    status: BrowserChannelRunStatus
  }): void => {
    const restoredStatus = status === "needs_you" ? "needs_you" : "running"
    database
      .query(
        "UPDATE browser_channel_runs SET status = ?, controller_person_id = NULL WHERE run_id = ? AND controller_person_id = ?",
      )
      .run(restoredStatus, runId, actorPersonId)
    publish(runId)
    if (restoredStatus === "needs_you") scheduleEscalation(runId)
  }
  const returnControl = ({
    runId,
    actorPersonId,
  }: {
    runId: string
    actorPersonId: string
  }): { success: true } | { success: false; error: string } => {
    const row = getRaw(runId)
    if (!row || !LIVE_STATUSES.includes(row.status))
      return { success: false, error: "Este navegador não está mais ativo." }
    if (
      !canControlChannelBrowserRun({
        actorPersonId,
        requesterPersonId: row.requester_person_id,
        responsiblePersonId: row.responsible_person_id,
      })
    )
      return { success: false, error: getBrowserRunControlError(personName(row.controller_person_id)) }
    database
      .query(`UPDATE browser_channel_runs SET status = 'running', controller_person_id = NULL,
        needs_you_at = NULL, escalated_at = NULL, resume_pending = 1 WHERE run_id = ?`)
      .run(runId)
    clearEscalation(runId)
    resolveNeedsYou(runId)
    publish(runId)
    resumeRequest(row.run_id)
    return { success: true }
  }
  const isPreviewHidden = (tabId: string): boolean =>
    Boolean(
      database
        .query(`SELECT 1 FROM browser_tabs tab JOIN threads owner_thread ON owner_thread.id = tab.owner_thread_id
          JOIN browser_channel_runs run ON run.group_id = owner_thread.group_id
            AND run.thread_id = owner_thread.group_thread_id AND run.bot_id = tab.owner_bot_id
          WHERE tab.id = ? AND run.controller_person_id IS NOT NULL
            AND run.status = 'taken_over' LIMIT 1`)
        .get(tabId),
    )
  const onRunUpdated = kernel.subscribe(({ event }) => {
    if (event.type !== "run.updated") return
    const row = getRaw(event.run.id)
    if (!row) return
    if (row.current_run_id !== event.run.id) {
      const continuation = database
        .query("SELECT original_run_id FROM browser_takeover_continuations WHERE run_id = ?")
        .get(event.run.id) as { original_run_id: string } | null
      if (continuation?.original_run_id !== row.run_id) return
      database
        .query("UPDATE browser_channel_runs SET current_run_id = ?, resume_pending = 0 WHERE run_id = ?")
        .run(event.run.id, row.run_id)
    }
    const awaitingContinuation = row.current_run_id === event.run.id && row.resume_pending === 1
    if (
      event.run.status === "succeeded" &&
      (awaitingContinuation || ["queued", "needs_you", "taken_over"].includes(row.status))
    )
      return
    if (
      event.run.status === "interrupted" &&
      event.run.errorClass === "app_restart" &&
      ["queued", "needs_you", "taken_over"].includes(row.status)
    )
      return
    if (event.run.status === "succeeded") updateTerminal(row.run_id, "succeeded")
    if (event.run.status === "failed" || event.run.status === "interrupted") updateTerminal(row.run_id, "failed")
    if (event.run.status === "canceled") updateTerminal(row.run_id, "canceled")
  })
  const restoreResumptions = (after = ""): void => {
    const resumable = database
      .query(
        "SELECT run_id FROM browser_channel_runs WHERE resume_pending = 1 AND status = 'running' AND run_id > ? ORDER BY run_id LIMIT 20",
      )
      .all(after) as Array<{ run_id: string }>
    resumable.forEach(({ run_id }) => {
      resumeRequest(run_id)
    })
    const last = resumable.at(-1)?.run_id
    if (resumable.length !== 20 || !last) return
    restoreTimer = setTimeout(() => restoreResumptions(last), 0)
    restoreTimer.unref()
  }
  restoreResumptions()
  const pending = database
    .query("SELECT run_id FROM browser_channel_runs WHERE status = 'needs_you' AND escalated_at IS NULL LIMIT 100")
    .all() as Array<{ run_id: string }>
  pending.forEach(({ run_id }) => {
    scheduleEscalation(run_id)
  })

  return {
    enter,
    cancelRequest,
    get,
    getForRun,
    getForTab,
    getCurrentRunId: (runId: string) => getRaw(runId)?.current_run_id ?? null,
    list,
    needsYou,
    takeControl,
    returnControl,
    restoreControl,
    isPreviewHidden,
    dispose: () => {
      onRunUpdated()
      if (restoreTimer) clearTimeout(restoreTimer)
      resumeTimers.forEach(clearTimeout)
      resumeTimers.clear()
      escalationTimers.forEach(clearTimeout)
      escalationTimers.clear()
    },
  }
}
