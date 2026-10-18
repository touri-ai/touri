import { Database } from "bun:sqlite"
import type { Bot, Goal, GoalControl, GoalStart, Id, Kernel, Result, Run } from "@touri/contracts"
import { folderGrantProblem } from "../kernel/folder-capability"

type GoalResult = Result<{ goal: Goal }, "INVALID_ARGS" | "CONFLICT" | "NOT_FOUND">
type GoalRow = { checkpoint_json: string }
type GoalHooks = {
  enqueue: (threadId: Id, requestMessageId: Id) => Run | null
  cancel: (runId: Id) => void
  getRuns: (threadId: Id) => Array<Run>
  isStopping: () => boolean
}

/** Goals add bounded scheduling only; provider access and approvals still belong to each ordinary turn. */
export const createGoalRuntime = (kernel: Kernel, hooks: GoalHooks, now = Date.now) => {
  const database = kernel.db instanceof Database ? kernel.db : null
  const getGoal = (threadId: Id): Goal | null =>
    getCheckpoint(database?.query("SELECT checkpoint_json FROM goals WHERE thread_id = ?").get(threadId))
  const getForRun = (runId: Id): Goal | null =>
    getCheckpoint(database?.query("SELECT checkpoint_json FROM goals WHERE run_id = ?").get(runId))
  const getActive = (): Array<Goal> =>
    ((database?.query("SELECT checkpoint_json FROM goals").all() ?? []) as Array<GoalRow>)
      .map((row) => JSON.parse(row.checkpoint_json) as Goal)
      .filter((goal) => goal.status === "active")

  const saveGoal = (goal: Goal): Goal => {
    if (!database) throw new Error("Goal persistence is unavailable")
    const next = { ...goal, updatedAt: now() }
    database
      .query(
        `INSERT INTO goals(thread_id, run_id, checkpoint_json) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET run_id = excluded.run_id, checkpoint_json = excluded.checkpoint_json`,
      )
      .run(next.threadId, next.runId, JSON.stringify(next))
    return next
  }

  const stopGoal = (goal: Goal, status: Goal["status"]): Goal => {
    const next = saveGoal({ ...goal, status })
    if (goal.runId) hooks.cancel(goal.runId)
    return next
  }

  const prepareContinuation = (goal: Goal): boolean => {
    if (goal.status !== "active") return false
    const bot = kernel.services.use("store.api")?.getBot({ botId: goal.botId })
    if (!bot || bot.paused || hasScopeProblem(bot)) {
      stopGoal(goal, "paused")
      return false
    }
    if (now() < goal.deadlineAt && goal.turnsUsed < goal.maxTurns) return true

    stopGoal(goal, "budget_exhausted")
    return false
  }

  const attachRun = (previousRunId: Id, nextRunId: Id): boolean => {
    const goal = getForRun(previousRunId)
    if (!goal) return true
    if (!prepareContinuation(goal)) return false

    saveGoal({ ...goal, runId: nextRunId, turnsUsed: goal.turnsUsed + 1 })
    return true
  }

  const startNext = (goal: Goal): Goal => {
    if (!prepareContinuation(goal)) return getGoal(goal.threadId) ?? goal
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId: goal.threadId })
    const bot = store?.getBot({ botId: goal.botId })
    if (!store || !thread || !bot || bot.paused || hasScopeProblem(bot) || hooks.isStopping())
      return saveGoal({ ...goal, status: "paused" })
    if (!store.activePath({ threadId: goal.threadId }).some((message) => message.id === goal.requestMessageId))
      return saveGoal({ ...goal, status: "paused" })
    if (hooks.getRuns(goal.threadId).some((run) => ["queued", "starting", "running"].includes(run.status)))
      return saveGoal({ ...goal, status: "paused" })

    const text = "Continuação do objetivo"
    const marker = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: goal.threadId,
        parentId: thread.activeLeafId,
        role: "system",
        kind: "notice",
        status: "complete",
        runId: null,
        text,
        parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
        sender: null,
        source: "local",
      },
    })
    if (!marker.success) return saveGoal({ ...goal, status: "paused" })
    const run = hooks.enqueue(goal.threadId, marker.message.id)
    if (!run) return saveGoal({ ...goal, status: "paused" })

    return saveGoal({ ...goal, runId: run.id, turnsUsed: goal.turnsUsed + 1 })
  }

  const startGoal = (threadId: Id, input: GoalStart): GoalResult => {
    if (!database) return getFailure("INVALID_ARGS")
    const store = kernel.services.use("store.api")
    const thread = store?.getThread({ threadId })
    const bot = thread ? store?.getBot({ botId: thread.botId }) : null
    if (!thread || !bot) return getFailure("NOT_FOUND")
    const previous = getGoal(threadId)
    if (previous && previous.status !== "completed") return getFailure("CONFLICT")
    if (thread.groupId || thread.groupThreadId || thread.kind === "routine" || hasScopeProblem(bot))
      return getFailure("INVALID_ARGS")
    if (!isValidBudget(input.maxTurns, input.maxMinutes)) return getFailure("INVALID_ARGS")
    if (typeof input.completionCriterion !== "string" || !input.completionCriterion.trim())
      return getFailure("INVALID_ARGS")
    if (input.completionCriterion.length > 2000) return getFailure("INVALID_ARGS")
    const request = store
      ?.activePath({ threadId })
      .filter((message) => message.role === "user")
      .at(-1)
    if (!request || request.id !== input.requestMessageId) return getFailure("INVALID_ARGS")
    if (hooks.getRuns(threadId).some((run) => ["queued", "starting", "running"].includes(run.status)))
      return getFailure("CONFLICT")
    const timestamp = now()
    const goal = saveGoal({
      id: kernel.newId(),
      threadId,
      botId: bot.id,
      requestMessageId: request.id,
      text: request.text,
      completionCriterion: input.completionCriterion.trim(),
      status: "active",
      maxTurns: input.maxTurns,
      turnsUsed: 0,
      deadlineAt: timestamp + input.maxMinutes * 60_000,
      runId: null,
      steps: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    return { success: true, goal: startNext(goal) }
  }

  const controlGoal = (threadId: Id, input: GoalControl): GoalResult => {
    const goal = getGoal(threadId)
    if (!goal) return getFailure("NOT_FOUND")
    if (goal.status === "completed") return getFailure("CONFLICT")
    if (input.action === "pause") return { success: true, goal: stopGoal(goal, "paused") }
    if (input.action === "complete") return { success: true, goal: stopGoal(goal, "completed") }
    if (input.action === "budget") {
      if (!isValidBudget(input.maxTurns, input.maxMinutes)) return getFailure("INVALID_ARGS")
      if (input.maxTurns === undefined || input.maxMinutes === undefined || input.maxTurns < goal.turnsUsed)
        return getFailure("INVALID_ARGS")

      return {
        success: true,
        goal: saveGoal({ ...goal, maxTurns: input.maxTurns, deadlineAt: now() + input.maxMinutes * 60_000 }),
      }
    }
    if (input.action !== "resume") return getFailure("INVALID_ARGS")
    if (goal.status === "active") return { success: true, goal }

    return { success: true, goal: startNext(saveGoal({ ...goal, status: "active" })) }
  }

  const recordCheckpoint = (args: { runId: Id; botId: Id; threadId: Id; step: string; completed: boolean }) => {
    const goal = getForRun(args.runId)
    if (goal?.status !== "active" || goal.botId !== args.botId || goal.threadId !== args.threadId)
      return getFailure("NOT_FOUND")
    if (typeof args.step !== "string" || !args.step.trim() || args.step.length > 1000) return getFailure("INVALID_ARGS")
    if (now() >= goal.deadlineAt) return { success: true as const, goal: stopGoal(goal, "budget_exhausted") }

    return {
      success: true as const,
      goal: saveGoal({
        ...goal,
        status: args.completed ? "completed" : "active",
        steps: [...goal.steps, { runId: args.runId, text: kernel.redact(args.step.trim()), at: now() }].slice(-50),
      }),
    }
  }

  const finishTurn = (run: Run, summary: string, hasContinuation: boolean): void => {
    const goal = getForRun(run.id)
    if (goal?.status !== "active" || hooks.isStopping() || hasContinuation) return
    if (run.status !== "succeeded") {
      saveGoal({ ...goal, status: "paused" })
      return
    }
    const latest = hooks.getRuns(goal.threadId)[0]
    if (latest?.id !== run.id) {
      saveGoal({ ...goal, status: "paused" })
      return
    }
    const steps = summary.trim()
      ? [...goal.steps, { runId: run.id, text: kernel.redact(summary.slice(-1000)), at: now() }].slice(-50)
      : goal.steps

    startNext(saveGoal({ ...goal, steps }))
  }

  const pauseForUser = (threadId: Id): void => {
    const goal = getGoal(threadId)
    if (goal?.status === "active") stopGoal(goal, "paused")
  }

  const expireRun = (runId: Id): void => {
    const goal = getForRun(runId)
    if (!goal || now() < goal.deadlineAt) return
    if (goal.status === "active") stopGoal(goal, "budget_exhausted")
    if (goal.status === "completed") hooks.cancel(runId)
  }

  return {
    getGoal,
    getForRun,
    getActive,
    saveGoal,
    prepareContinuation,
    attachRun,
    startGoal,
    controlGoal,
    recordCheckpoint,
    finishTurn,
    pauseForUser,
    expireRun,
  }
}

export const getGoalPrompt = (goal: Goal): string =>
  [
    "[touri: user-authorized bounded goal. Continue from observed work; check current state before repeating effects.",
    `Goal: ${goal.text}`,
    `Agreed completion criterion: ${goal.completionCriterion}`,
    `Budget: ${goal.maxTurns - goal.turnsUsed} further turns, deadline ${new Date(goal.deadlineAt).toISOString()}.`,
    `Observed steps: ${JSON.stringify(goal.steps)}`,
    "Use goal_checkpoint to record observed progress. Set completed=true only when the criterion is verified, and describe the evidence.",
    "Ending a turn does not complete this goal. All existing permissions and approvals remain mandatory; never widen access.]",
  ].join("\n")

const getCheckpoint = (row: unknown): Goal | null =>
  row ? (JSON.parse((row as GoalRow).checkpoint_json) as Goal) : null

const isValidBudget = (turns: unknown, minutes: unknown): boolean =>
  typeof turns === "number" &&
  Number.isInteger(turns) &&
  turns >= 1 &&
  turns <= 20 &&
  typeof minutes === "number" &&
  Number.isInteger(minutes) &&
  minutes >= 1 &&
  minutes <= 240

const hasScopeProblem = (bot: Bot): boolean =>
  bot.machine !== "local" ||
  !(bot.projectId || bot.folders?.length || bot.anyFolderAccess) ||
  (bot.access !== "full" && !!folderGrantProblem(bot))

const getFailure = (errorCode: "INVALID_ARGS" | "CONFLICT" | "NOT_FOUND") => ({
  success: false as const,
  errorCode,
  error: errorCode,
})
