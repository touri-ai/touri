import type { Database } from "bun:sqlite"
import {
  describeRoutineSchedule,
  type GoalControl,
  type GoalStart,
  type Id,
  type Kernel,
  type RouteModule,
  type Routine,
  type ToolHandler,
  type ToolResult,
} from "@touri/contracts"
import { createGroupRuntime } from "../groups/runtime"
import { deviceSession } from "../kernel/device-session"
import type { PerformanceStageRunner } from "../kernel/performance"
import { buildChildEnv } from "../kernel/shell-env"
import { getHostIdentity } from "../platform/host"
import { createTeamTools } from "../teams/tools"
import { createRuntimeEngine } from "./engine"
import { listOpenCodeModels } from "./opencode/models"
import { listProviderProfiles } from "./provider-profiles"
import { createRoutineScheduler } from "./routines/scheduler"
import { asRecord } from "./utils"

export const name = "runtime"

const bodyRecord = (value: unknown): Record<string, unknown> => asRecord(value) ?? {}
const stringField = (value: Record<string, unknown>, key: string, fallback = ""): string =>
  typeof value[key] === "string" ? value[key] : fallback
const numberField = (value: Record<string, unknown>, key: string, fallback: number): number =>
  typeof value[key] === "number" ? value[key] : fallback
const booleanField = (value: Record<string, unknown>, key: string, fallback: boolean): boolean =>
  typeof value[key] === "boolean" ? value[key] : fallback
const continuityField = (value: unknown): Routine["continuity"] =>
  value === "results-thread" || value === "main-thread" ? value : "new-thread"
const overlapField = (value: unknown): Routine["overlap"] => (value === "queue" ? "queue" : "skip")

const getRouteErrorStatus = (errorCode: string): number => {
  if (errorCode === "NOT_FOUND" || errorCode === "THREAD_NOT_FOUND") return 404
  if (errorCode === "BOT_PAUSED") return 409
  if (errorCode === "DENIED") return 403
  if (errorCode === "RUNTIME_DRAINING") return 503

  return 400
}

const routeError = (
  errorCode: string,
  error: string,
): { status: number; json: { errorCode: string; error: string } } => ({
  status: getRouteErrorStatus(errorCode),
  json: { errorCode, error },
})

const textResult = (text: string, structured?: unknown): ToolResult => ({
  success: true,
  content: [{ type: "text", text }],
  ...(structured === undefined ? {} : { structured }),
})
const toolError = (errorCode: string, error: string): ToolResult => ({
  success: false,
  errorCode,
  error,
  content: [{ type: "text", text: `ERROR ${errorCode}: ${error}` }],
})

const routineInput = ({
  args,
  botId,
  enabled,
  groupId = null,
}: {
  args: Record<string, unknown>
  botId: Id
  enabled: boolean
  groupId?: Id | null
}): Parameters<ReturnType<typeof createRuntimeEngine>["createRoutine"]>[0]["input"] => ({
  botId,
  name: stringField(args, "name"),
  prompt: stringField(args, "prompt"),
  cron: stringField(args, "cron"),
  timezone: stringField(args, "timezone"),
  enabled,
  continuity: continuityField(args.continuity),
  resultsThreadId: typeof args.resultsThreadId === "string" ? args.resultsThreadId : null,
  groupId,
  timeoutMinutes: numberField(args, "timeoutMinutes", 30),
  overlap: overlapField(args.overlap),
  catchUpMinutes: numberField(args, "catchUpMinutes", 30),
})

export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const engine = createRuntimeEngine({ kernel, ...(runStage ? { runStage } : {}) })
  let draining = false
  let drainPromise: Promise<void> | null = null
  kernel.services.provide("runtime.isDraining", () => draining)
  kernel.services.provide("runtime.settingsChanged", engine.settingsChanged)
  await engine.ready
  const groups = createGroupRuntime(kernel, engine)
  kernel.services.provide("groups.runtime", groups)
  const scheduler = createRoutineScheduler({ kernel, engine, ...(runStage ? { runStage } : {}) })

  kernel.services.provide("runtime.beginDrain", () => {
    if (drainPromise) return drainPromise
    draining = true
    scheduler.stop()
    groups.beginDrain()
    engine.beginDrain()
    drainPromise = (async () => {
      await groups.waitForDrain()
      await engine.waitForDrain()
    })()
    return drainPromise
  })
  kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
    if (draining) return { success: false, errorCode: "RUNTIME_DRAINING", error: "O servidor está encerrando." }

    const result = groups.enqueue({ threadId, requestMessageId, trigger })
    if (!result.success) return result

    return { success: true, run: engine.getRunSnapshot(result.run) }
  })
  kernel.services.provide("runtime.answerApproval", (args) => engine.answerApproval(args))
  kernel.services.provide("approvals.present", engine.approvalBridge.present)
  kernel.services.provide("approvals.approve", engine.approvalBridge.approve)
  kernel.services.provide("approvals.settle", engine.approvalBridge.settle)
  kernel.services.provide("approvals.completeTeam", engine.approvalBridge.completeTeam)
  kernel.services.provide("runtime.activeRun", ({ threadId }) => engine.activeRun({ threadId }))
  kernel.services.provide("runtime.continueAfterApproval", engine.continueAfterApproval)
  kernel.services.provide("runtime.cancelBotTurns", groups.cancelBotTurns)
  kernel.services.provide("runtime.cancelRun", ({ runId }) => {
    const grouped = groups.cancel(runId)
    return engine.cancel(runId).success || grouped
  })
  kernel.services.provide("runtime.shutdown", async (options) => {
    draining = true
    scheduler.stop()
    groups.shutdown(options)
    await engine.shutdown()
    await groups.waitForDrain()
  })
  kernel.services.use("store.api")?.drainSendQueue?.()

  const routes: RouteModule = {
    name,
    routes: [
      {
        method: "GET",
        path: "/providers/opencode/models",
        handler: async ({ query }) => {
          const bot = query.botId ? kernel.services.use("store.api")?.getBot({ botId: query.botId }) : undefined
          if (query.botId && !bot) return routeError("NOT_FOUND", "Bot não encontrado")
          return { status: 200, json: await listOpenCodeModels(kernel, bot ?? undefined) }
        },
      },
      {
        method: "GET",
        path: "/provider-profiles",
        handler: async () => ({
          status: 200,
          json: {
            profiles: await listProviderProfiles({
              appData: kernel.paths.appData,
              env: buildChildEnv({ base: await kernel.shellEnv() }),
            }),
          },
        }),
      },
      {
        method: "GET",
        path: "/runs",
        handler: async ({ signal }) => {
          const runs = engine.getWorkRuns()
          const person = deviceSession(signal)?.person
          const visibleRuns =
            !person || person.role === "admin"
              ? runs
              : (() => {
                  const visibleIds = kernel.services.use("work.accessibleRunIds")?.({
                    personId: person.id,
                    channelIds: kernel.services.use("work.personChannelIds")?.(person.id) ?? [],
                    runIds: runs.map((run) => run.id),
                  })
                  const visible = new Set(visibleIds ?? [])
                  return runs.filter((run) => visible.has(run.id))
                })()
          return {
            status: 200,
            json: { runs: visibleRuns, draining: kernel.services.use("runtime.isDraining")?.() ?? false },
          }
        },
      },
      {
        method: "GET",
        path: "/threads/:id/goal",
        handler: async ({ params }) => ({ status: 200, json: { goal: engine.goals.getGoal(params.id ?? "") } }),
      },
      {
        method: "POST",
        path: "/threads/:id/goal",
        handler: async ({ params, body }) => {
          const result = engine.goals.startGoal(params.id ?? "", bodyRecord(body) as GoalStart)
          return result.success
            ? { status: 201, json: { goal: result.goal } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "PATCH",
        path: "/threads/:id/goal",
        handler: async ({ params, body }) => {
          const result = engine.goals.controlGoal(params.id ?? "", bodyRecord(body) as GoalControl)
          return result.success
            ? { status: 200, json: { goal: result.goal } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "GET",
        path: "/threads/:id/runs",
        handler: async ({ params, query }) => {
          const thread = kernel.services.use("store.api")?.getThread({ threadId: params.id ?? "" })
          if (thread && kernel.services.use("store.api")?.getBot({ botId: thread.botId })?.machine === "cloud") {
            const cloud = kernel.services.use("cloud.account")
            if (!cloud) return routeError("TOURI-E9013", "Nuvem desativada")
            return {
              status: 200,
              json: await cloud.request(
                "GET",
                `/v1/threads/${encodeURIComponent(thread.id)}/runs${query.all === "true" ? "?all=true" : ""}`,
              ),
            }
          }
          return {
            status: 200,
            json: { runs: groups.listRuns(params.id ?? "", { all: query.all === "true" }).map(engine.getRunSnapshot) },
          }
        },
      },
      {
        method: "POST",
        path: "/runs/:id/cancel",
        handler: async ({ params }) => {
          const remote = (kernel.db as Database)
            .query("SELECT bot_id FROM cloud_runs WHERE run_id = ?")
            .get(params.id ?? "")
          if (remote) {
            const cloud = kernel.services.use("cloud.account")
            if (!cloud) return routeError("TOURI-E9013", "Nuvem desativada")
            return {
              status: 200,
              json: await cloud.request("POST", `/v1/runs/${encodeURIComponent(params.id ?? "")}/cancel`, {}),
            }
          }
          groups.cancel(params.id ?? "")
          const result = engine.cancel(params.id ?? "")
          return result.success
            ? { status: 200, json: { run: engine.getRunSnapshot(result.run) } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "POST",
        path: "/runs/:id/retry",
        handler: async ({ params }) => {
          const result = groups.retry(params.id ?? "") ?? engine.retry(params.id ?? "")
          return result.success
            ? { status: 200, json: { run: engine.getRunSnapshot(result.run) } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "POST",
        path: "/approvals/:id",
        handler: async ({ params, body, signal }) => {
          const person = deviceSession(signal)?.person
          if (
            person?.role === "member" &&
            !kernel.services.use("work.canApprove")?.({
              personId: person.id,
              approvalId: params.id ?? "",
            })
          )
            return routeError("DENIED", "Only the responsible person can approve this request")
          const decision = stringField(bodyRecord(body), "decision")
          if (decision !== "approved" && decision !== "denied")
            return routeError("INVALID_ARGS", "decision must be approved or denied")
          const result = await engine.answerApproval({
            approvalId: params.id ?? "",
            decision,
            standing: bodyRecord(body).standing === true,
            source: "card",
          })
          return result.success ? { status: 200, json: {} } : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "GET",
        path: "/routines",
        handler: async ({ query }) => ({
          status: 200,
          json: { routines: engine.listRoutines(query.botId), ...getHostIdentity() },
        }),
      },
      {
        method: "GET",
        path: "/routine-runs",
        handler: async ({ query }) => {
          const from = query.from ? Number(query.from) : Number.NEGATIVE_INFINITY
          const to = query.to ? Number(query.to) : Number.POSITIVE_INFINITY
          const routineRuns = engine
            .listRoutines(query.botId)
            .flatMap((routine) => engine.listRoutineRuns(routine.id))
            .filter((routineRun) => routineRun.scheduledFor >= from && routineRun.scheduledFor <= to)
          return { status: 200, json: { routineRuns } }
        },
      },
      {
        method: "POST",
        path: "/routines",
        handler: async ({ body }) => {
          const args = bodyRecord(body)
          const botId = stringField(args, "botId")
          const input = routineInput({
            args,
            botId,
            enabled: booleanField(args, "enabled", false),
            groupId: typeof args.groupId === "string" ? args.groupId : null,
          })
          const result = engine.createRoutine({ input, forceDisabled: false })
          return result.success
            ? { status: 201, json: { routine: result.routine } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "PATCH",
        path: "/routines/:id",
        handler: async ({ params, body }) => {
          const args = bodyRecord(body)
          const patch: Partial<Routine> = {}
          if (typeof args.name === "string") patch.name = args.name
          if (typeof args.prompt === "string") patch.prompt = args.prompt
          if (typeof args.cron === "string") patch.cron = args.cron
          if (typeof args.timezone === "string") patch.timezone = args.timezone
          if (typeof args.enabled === "boolean") patch.enabled = args.enabled
          if (args.continuity !== undefined) patch.continuity = continuityField(args.continuity)
          if (args.resultsThreadId === null || typeof args.resultsThreadId === "string")
            patch.resultsThreadId = args.resultsThreadId
          if (args.groupId === null || typeof args.groupId === "string") patch.groupId = args.groupId
          if (args.timeoutMinutes !== undefined) patch.timeoutMinutes = numberField(args, "timeoutMinutes", 30)
          if (args.overlap !== undefined) patch.overlap = overlapField(args.overlap)
          if (args.catchUpMinutes !== undefined) patch.catchUpMinutes = numberField(args, "catchUpMinutes", 30)
          const result = engine.updateRoutine({ routineId: params.id ?? "", patch, fromTool: false })
          return result.success
            ? { status: 200, json: { routine: result.routine } }
            : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "DELETE",
        path: "/routines/:id",
        handler: async ({ params }) => {
          const result = engine.deleteRoutine(params.id ?? "")
          return result.success ? { status: 200, json: {} } : routeError(result.errorCode, result.error)
        },
      },
      {
        method: "POST",
        path: "/routines/:id/run",
        handler: async ({ params }) => {
          const result = engine.runRoutine({ routineId: params.id ?? "", triggerSource: "manual" })
          return result.success
            ? { status: 201, json: { routineRun: result.routineRun } }
            : routeError(result.errorCode, result.error)
        },
      },
    ],
  }
  kernel.registerRoutes(routes)

  const routineList: ToolHandler = async ({ ctx }) =>
    textResult(JSON.stringify(engine.listRoutines(ctx.botId)), engine.listRoutines(ctx.botId))
  const routineCreate: ToolHandler = async ({ ctx, args }) => {
    const input = routineInput({ args: bodyRecord(args), botId: ctx.botId, enabled: false })
    const result = engine.createRoutine({ input, forceDisabled: true })
    if (!result.success) return toolError(result.errorCode, result.error)
    const routine = result.routine
    const reviewed = JSON.stringify(routine)
    const isCurrent = () =>
      !ctx.signal.aborted &&
      JSON.stringify(engine.listRoutines(ctx.botId).find((value) => value.id === routine.id)) === reviewed
    const approval = await kernel.services.use("approvals.present")?.({
      ctx,
      scope: { source: "mcp", server: "touri", tool: "routine_create" },
      toolName: "routine_create",
      input: {
        routineId: routine.id,
        name: routine.name,
        cron: routine.cron,
        schedule: describeRoutineSchedule(routine.cron, routine.timezone),
        timezone: routine.timezone,
        continuity: routine.continuity,
        timeoutMinutes: routine.timeoutMinutes,
        // Bound before JSON serialization: even escaped control characters must
        // leave room for the complete reviewed target and schedule.
        promptPreview: routine.prompt.length > 512 ? `${routine.prompt.slice(0, 512)}…` : routine.prompt,
        promptLength: routine.prompt.length,
      },
      allowStanding: false,
      isCurrent,
    })
    if (!approval?.success || approval.behavior !== "allow" || !isCurrent())
      return textResult(`Routine ${routine.name} remains paused; activation was not approved.`, routine)
    // Only this explicit user approval can enable the reviewed routine; the tool
    // update path still rejects enabled=true.
    const activated = engine.updateRoutine({ routineId: routine.id, patch: { enabled: true }, fromTool: false })
    return activated.success
      ? textResult(`Created active routine ${activated.routine.name}`, activated.routine)
      : toolError(activated.errorCode, activated.error)
  }
  const routineUpdate: ToolHandler = async ({ ctx, args }) => {
    const values = bodyRecord(args)
    const patch: Partial<Routine> = {}
    if (typeof values.name === "string") patch.name = values.name
    if (typeof values.prompt === "string") patch.prompt = values.prompt
    if (typeof values.cron === "string") patch.cron = values.cron
    if (typeof values.timezone === "string") patch.timezone = values.timezone
    if (values.enabled === true) return toolError("INVALID_ARGS", "Agents cannot enable routines")
    if (values.enabled === false) patch.enabled = false
    const result = engine.updateRoutine({
      routineId: stringField(values, "routineId"),
      patch,
      fromTool: true,
      botId: ctx.botId,
    })
    return result.success
      ? textResult(`Updated routine ${result.routine.name}`, result.routine)
      : toolError(result.errorCode, result.error)
  }
  const approvalPrompt = createApprovalPromptHandler(engine)
  const registration = kernel.registerTools({
    tools: [
      ...createTeamTools(kernel),
      { name: "coordinate_bots", group: "core", handler: ({ ctx, args }) => groups.askBot(ctx, args) },
      { name: "ask_all", group: "core", handler: ({ ctx, args }) => groups.askAll(ctx, args) },
      { name: "ask_bot", group: "core", handler: ({ ctx, args }) => groups.askBot(ctx, args) },
      { name: "goal_checkpoint", group: "core", handler: createGoalCheckpointHandler(engine) },
      { name: "routine_list", group: "core", handler: routineList },
      { name: "routine_create", group: "core", handler: routineCreate },
      { name: "routine_update", group: "core", handler: routineUpdate },
      { name: "approval_prompt", group: "core", handler: approvalPrompt },
      { name: "approval_context", group: "core", handler: createApprovalContextHandler(engine.approvalBridge) },
    ],
  })
  if (!registration.success)
    kernel.log({
      level: "error",
      module: name,
      msg: "Unable to register runtime tools",
      data: { errorCode: registration.errorCode },
    })

  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") {
      scheduler.stop()
      groups.shutdown()
      void engine.shutdown()
    }
  })
}

export const createApprovalPromptHandler =
  (engine: Pick<ReturnType<typeof createRuntimeEngine>, "approvalPrompt">): ToolHandler =>
  async ({ ctx, args }) => {
    const values = bodyRecord(args)
    const toolUseId = stringField(values, "tool_use_id")
    const result = toolUseId
      ? await engine.approvalPrompt({
          ctx,
          toolName: stringField(values, "tool_name"),
          input: values.input ?? {},
          toolUseId,
        })
      : await engine.approvalPrompt({ ctx, toolName: stringField(values, "tool_name"), input: values.input ?? {} })
    const decision = result.success
      ? result.behavior === "allow"
        ? { behavior: "allow", updatedInput: result.updatedInput ?? {} }
        : { behavior: "deny", message: result.message ?? "Permissão negada pelo usuário." }
      : { behavior: "deny", message: result.error }
    // Claude Code requires exactly one JSON text block, with no structuredContent.
    return textResult(JSON.stringify(decision))
  }

export const createApprovalContextHandler =
  (bridge: Pick<ReturnType<typeof createRuntimeEngine>["approvalBridge"], "context">): ToolHandler =>
  async ({ ctx, args }) => {
    const values = bodyRecord(args)
    let input = values.input
    if (typeof input === "string") {
      try {
        input = JSON.parse(input)
      } catch {
        return textResult("{}")
      }
    }
    const message = bridge.context({
      ctx,
      toolName: stringField(values, "tool_name"),
      toolUseId: stringField(values, "tool_use_id"),
      input,
    })
    return textResult(
      JSON.stringify(
        message
          ? {
              hookSpecificOutput: { hookEventName: stringField(values, "hook_event_name"), additionalContext: message },
            }
          : {},
      ),
    )
  }

export const createGoalCheckpointHandler =
  (engine: Pick<ReturnType<typeof createRuntimeEngine>, "goals" | "activeRun">): ToolHandler =>
  async ({ ctx, args }) => {
    const run = engine.activeRun({ threadId: ctx.threadId })
    if (ctx.signal.aborted || !ctx.runId || run?.id !== ctx.runId || run.botId !== ctx.botId)
      return toolError("NOT_FOUND", "Não há um objetivo ativo para este turno.")
    const values = bodyRecord(args)
    if (typeof values.completed !== "boolean")
      return toolError("INVALID_ARGS", "Não foi possível registrar a conclusão do objetivo.")
    const result = engine.goals.recordCheckpoint({
      runId: ctx.runId,
      botId: ctx.botId,
      threadId: ctx.threadId,
      step: stringField(values, "step"),
      completed: values.completed,
    })

    return result.success
      ? textResult(JSON.stringify(result.goal), result.goal)
      : toolError(result.errorCode, result.error)
  }
