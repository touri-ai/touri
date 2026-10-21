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
  request_id: string | null
  active_run_id: string | null
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
    // Sorting this fresh filtered array cannot mutate the caller's queue.
    .sort((first, second) => first.queuedAt - second.queuedAt || first.runId.localeCompare(second.runId))[0]

const selectRunSql = `SELECT c.*,
  CASE WHEN c.status = 'queued' THEN 1 + (
    SELECT COUNT(*) FROM browser_channel_runs queued
    WHERE queued.bot_id = c.bot_id AND queued.status = 'queued'
      AND (queued.queued_at < c.queued_at OR (queued.queued_at = c.queued_at AND queued.run_id < c.run_id))
  ) ELSE NULL END AS queue_position
  FROM browser_channel_runs c`

export const getBrowserTabRunId = (database: Database, tabId: string): string | null => {
  const tab = database
    .query(`SELECT tab.owner_bot_id AS bot_id,
    COALESCE(thread.group_thread_id, thread.id) AS thread_id
    FROM browser_tabs tab JOIN threads thread ON thread.id = tab.owner_thread_id WHERE tab.id = ?`)
    .get(tabId) as { bot_id: string | null; thread_id: string } | null
  if (!tab?.bot_id) return null
  const active = database
    .query(`SELECT run_id FROM browser_channel_runs WHERE bot_id = ? AND thread_id = ?
    AND status IN ('running','needs_you','taken_over') LIMIT 1`)
    .get(tab.bot_id, tab.thread_id) as { run_id: string } | null
  if (active) return active.run_id
  const previous = database
    .query(`SELECT run_id FROM browser_channel_runs WHERE thread_id = ? AND bot_id = ?
    AND status != 'queued' ORDER BY queued_at DESC, run_id DESC LIMIT 1`)
    .get(tab.thread_id, tab.bot_id) as { run_id: string } | null

  return previous?.run_id ?? null
}

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
  const escalationTimers = new Map<Id, ReturnType<typeof setTimeout>>()
  const personName = (personId: string | null): string | null =>
    personId ? (kernel.services.use("work.personName")?.(personId) ?? null) : null
  const getRaw = (runId: string): BrowserChannelRunRow | null =>
    (database.query(`${selectRunSql} WHERE c.run_id = ?`).get(runId) as BrowserChannelRunRow | null) ?? null
  const toPublic = (row: BrowserChannelRunRow): BrowserChannelRun => ({
    runId: row.run_id,
    requestId: row.request_id ?? row.run_id,
    activeRunId: row.active_run_id ?? row.run_id,
    runIds: (
      database
        .query("SELECT run_id FROM browser_request_runs WHERE request_run_id = ? LIMIT 100")
        .all(row.run_id) as Array<{ run_id: string }>
    ).map((link) => link.run_id),
    groupId: row.group_id,
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
    if (run) kernel.publish({ type: "browser.channel_run", run })
  }
  const publishQueue = (botId: string): void => {
    const rows = database
      .query(`${selectRunSql} WHERE c.bot_id = ? AND c.status = 'queued'
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
      .query(`${selectRunSql} WHERE c.status IN ('queued','running','needs_you','taken_over') ${scope}
        ORDER BY c.group_id, c.thread_id, c.bot_id, c.queued_at, c.run_id LIMIT 100`)
      .all(...(groupIds ?? [])) as BrowserChannelRunRow[]
    return rows.map(toPublic)
  }
  const getForTab = (tabId: string): BrowserChannelRun | null => {
    const runId = getBrowserTabRunId(database, tabId)
    return runId ? get(runId) : null
  }
  const getForRun = (runId: string): BrowserChannelRun | null => {
    const row = database
      .query(`${selectRunSql}
        LEFT JOIN group_run_links link ON link.run_id = c.active_run_id
        WHERE (c.run_id = ? OR c.active_run_id = ? OR link.turn_id = ?) AND c.status IN ('running','needs_you','taken_over')
        ORDER BY c.queued_at DESC LIMIT 1`)
      .get(runId, runId, runId) as BrowserChannelRunRow | null
    return row ? toPublic(row) : null
  }
  const getContext = (ctx: Pick<ToolContext, "runId" | "botId">) => {
    if (!ctx.runId) return null
    return database
      .query(`SELECT t.group_id, COALESCE(t.group_thread_id, t.id) AS group_thread_id,
          COALESCE(parent.request_message_id, original.request_message_id, r.request_message_id, r.id) AS request_id,
          COALESCE(r.requester_person_id, original.requester_person_id) AS requester_person_id, b.responsible_person_id
        FROM runs r JOIN threads t ON t.id = r.thread_id JOIN bots b ON b.id = r.bot_id
        LEFT JOIN run_continuations continuation ON continuation.run_id = r.id
        LEFT JOIN browser_takeover_continuations browser_continuation ON browser_continuation.run_id = r.id
        LEFT JOIN runs original ON original.id = COALESCE(continuation.original_run_id, browser_continuation.original_run_id)
        LEFT JOIN group_run_links link ON link.run_id = COALESCE(original.id, r.id)
        LEFT JOIN runs parent ON parent.id = link.turn_id
        WHERE r.id = ? AND r.bot_id = ? LIMIT 1`)
      .get(ctx.runId, ctx.botId) as {
      group_id: string | null
      group_thread_id: string | null
      request_id: string
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
            channelId: current.thread_id,
            botId: row.bot_id,
            queuedAt: row.queued_at,
          })),
          active: new Set(),
        })
        if (!next) return [runId]
        database
          .query(
            "UPDATE browser_channel_runs SET status = 'running', started_at = ? WHERE run_id = ? AND status = 'queued'",
          )
          .run(now(), next.runId)
        return [runId, next.runId]
      })
      .immediate()
    if (changed.length === 0) return
    clearEscalation(runId)
    resolveNeedsYou(runId)
    changed.forEach(publish)
    const scope = database.query("SELECT thread_id, bot_id FROM browser_channel_runs WHERE run_id = ?").get(runId) as {
      thread_id: string
      bot_id: string
    } | null
    if (scope) publishQueue(scope.bot_id)
  }
  const cancelQueued = (runId: string): void => {
    const scope = database.query("SELECT thread_id, bot_id FROM browser_channel_runs WHERE run_id = ?").get(runId) as {
      thread_id: string
      bot_id: string
    } | null
    const changed = database
      .query(
        "UPDATE browser_channel_runs SET status = 'canceled', finished_at = ? WHERE run_id = ? AND status = 'queued'",
      )
      .run(now(), runId).changes
    if (changed > 0) {
      publish(runId)
      if (scope) publishQueue(scope.bot_id)
    }
  }
  const waitForActivation = ({ runId, signal }: { runId: string; signal: AbortSignal }): Promise<boolean> =>
    new Promise((resolve) => {
      let dispose = () => {}
      const finish = (active: boolean): void => {
        dispose()
        signal.removeEventListener("abort", onAbort)
        resolve(active)
      }
      const check = (): void => {
        const row = getRaw(runId)
        if (row?.status === "running") finish(true)
        else if (!row || !["queued", "needs_you", "taken_over"].includes(row.status)) finish(false)
      }
      const onAbort = (): void => {
        cancelQueued(runId)
        finish(false)
      }
      dispose = kernel.subscribe(({ event }) => {
        if (event.type === "browser.channel_run" && event.run.runId === runId) check()
      })
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
      else check()
    })
  const enter = async (
    ctx: ToolContext,
  ): Promise<{ success: true } | { success: false; errorCode: string; error: string }> => {
    if (!ctx.runId || ctx.signal.aborted) return { success: true }
    if (!kernel.services.use("work.personChannelIds")) return { success: true }
    const context = getContext(ctx)
    if (!context?.group_thread_id) return { success: true }
    const previous = database
      .query("SELECT run_id FROM browser_channel_runs WHERE bot_id = ? AND request_id = ?")
      .get(ctx.botId, context.request_id) as { run_id: string } | null
    const runId = previous?.run_id ?? ctx.runId
    const outcome = database
      .transaction(() => {
        const existing = database.query("SELECT status FROM browser_channel_runs WHERE run_id = ?").get(runId) as {
          status: BrowserChannelRunStatus
        } | null
        if (existing) return { status: existing.status, inserted: false }
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
            (run_id,request_id,active_run_id,group_id,thread_id,bot_id,requester_person_id,responsible_person_id,status,queued_at,started_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            runId,
            context.request_id,
            ctx.runId,
            context.group_id,
            context.group_thread_id,
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
    database
      .query("INSERT OR IGNORE INTO browser_request_runs(run_id,request_run_id) VALUES (?,?)")
      .run(ctx.runId, runId)
    if (outcome.status === "running") {
      database.query("UPDATE browser_channel_runs SET active_run_id = ? WHERE run_id = ?").run(ctx.runId, runId)
      database
        .query("INSERT OR IGNORE INTO browser_request_runs(run_id,request_run_id) VALUES (?,?)")
        .run(ctx.runId, runId)
      publish(runId)
      return { success: true }
    }
    if (outcome.inserted) publish(runId)
    if (outcome.status !== "queued" && outcome.status !== "needs_you" && outcome.status !== "taken_over")
      return { success: false, errorCode: "BROWSER_RUN_FINISHED", error: "Este turno do navegador já foi encerrado." }
    const active = await waitForActivation({ runId, signal: ctx.signal })
    return active
      ? { success: true }
      : {
          success: false,
          errorCode: "BROWSER_RUN_CANCELED",
          error: "O turno do navegador foi cancelado antes de começar.",
        }
  }
  const needsYou = (runId: string | null, _reason: string): boolean => {
    if (!runId) return false
    const row = getRaw(runId)
    if (!row || !["running", "needs_you"].includes(row.status)) return false
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
        body: "O bot pausou o navegador e precisa que você assuma o controle para continuar.",
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
        needs_you_at = NULL, escalated_at = NULL WHERE run_id = ?`)
      .run(runId)
    clearEscalation(runId)
    resolveNeedsYou(runId)
    publish(runId)
    return { success: true }
  }
  const isPreviewHidden = (tabId: string): boolean =>
    Boolean(
      database
        .query(`SELECT 1 FROM browser_tabs tab JOIN threads owner_thread ON owner_thread.id = tab.owner_thread_id
          JOIN browser_channel_runs run ON run.group_id IS owner_thread.group_id
            AND run.thread_id = COALESCE(owner_thread.group_thread_id, owner_thread.id) AND run.bot_id = tab.owner_bot_id
          WHERE tab.id = ? AND run.controller_person_id IS NOT NULL
            AND run.status = 'taken_over' LIMIT 1`)
        .get(tabId),
    )
  const onRunUpdated = kernel.subscribe(({ event }) => {
    if (event.type !== "run.updated" || event.run.groupTurnId) return
    const context = event.run.botId ? getContext({ runId: event.run.id, botId: event.run.botId }) : null
    const row = context
      ? (database
          .query("SELECT run_id,active_run_id,status FROM browser_channel_runs WHERE bot_id = ? AND request_id = ?")
          .get(event.run.botId, context.request_id) as {
          run_id: string
          active_run_id: string | null
          status: BrowserChannelRunStatus
        } | null)
      : getRaw(event.run.id)
    if (!row) return
    if (row.active_run_id && row.active_run_id !== event.run.id) {
      const continuation = database
        .query(`SELECT continuation.previous_run_id, request.next_turn_id
        FROM browser_takeover_continuations continuation
        LEFT JOIN browser_resume_requests request ON request.previous_run_id = continuation.previous_run_id
        JOIN browser_request_runs alias ON alias.run_id = continuation.previous_run_id
        WHERE continuation.run_id = ? AND alias.request_run_id = ? LIMIT 1`)
        .get(event.run.id, row.run_id) as { previous_run_id: string; next_turn_id: string | null } | null
      if (!continuation || ![continuation.previous_run_id, continuation.next_turn_id].includes(row.active_run_id))
        return
      database
        .transaction(() => {
          database
            .query("UPDATE browser_channel_runs SET active_run_id = ? WHERE run_id = ?")
            .run(event.run.id, row.run_id)
          database
            .query("INSERT OR IGNORE INTO browser_request_runs(run_id,request_run_id) VALUES (?,?)")
            .run(event.run.id, row.run_id)
        })
        .immediate()
    }
    if (event.run.status === "succeeded" && ["needs_you", "taken_over"].includes(row.status)) return
    if (event.run.status === "succeeded") updateTerminal(row.run_id, "succeeded")
    if (event.run.status === "failed" || event.run.status === "interrupted") updateTerminal(row.run_id, "failed")
    if (event.run.status === "canceled") updateTerminal(row.run_id, "canceled")
  })
  const pending = database
    .query("SELECT run_id FROM browser_channel_runs WHERE status = 'needs_you' AND escalated_at IS NULL LIMIT 100")
    .all() as Array<{ run_id: string }>
  pending.forEach(({ run_id }) => {
    scheduleEscalation(run_id)
  })

  return {
    enter,
    get,
    getForRun,
    getForTab,
    list,
    needsYou,
    takeControl,
    returnControl,
    isPreviewHidden,
    cancel: (runId: string) => updateTerminal(runId, "canceled"),
    expire: (runId: string) => updateTerminal(runId, "failed"),
    dispose: () => {
      onRunUpdated()
      escalationTimers.forEach(clearTimeout)
      escalationTimers.clear()
    },
  }
}
