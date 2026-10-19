import { type ApprovalPart, getNotificationBody, type Id, type Kernel, type NotifyResolution } from "@touri/contracts"
import { approvalSummary } from "@touri/contracts/approval-summary"

const DETAIL_MAX = 600
const QUESTION_TOOL = "AskUserQuestion"

/** One open deferral per routine: repeats collapse into it and a later run of the routine closes it. */
export const getDeferredRequestId = (routineId: Id): string => `routine-deferred:${routineId}`

const clip = ({ value, max }: { value: string; max: number }): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

const questionText = (input: unknown): string => {
  if (typeof input !== "object" || input === null) return "The bot has a question"
  const record = input as Record<string, unknown>
  const first = Array.isArray(record.questions)
    ? (record.questions[0] as Record<string, unknown> | undefined)
    : undefined
  const asked = typeof first?.question === "string" ? first.question : record.question
  return typeof asked === "string" && asked.length > 0 ? asked : "The bot has a question"
}

/** Emits user-facing notifications for runtime events. Every call tolerates a missing notify module. */
export const createRuntimeNotices = ({ kernel }: { kernel: Kernel }) => {
  const emit = kernel.services.use.bind(kernel.services)

  const approval = ({
    botId,
    threadId,
    requestId,
    request,
    detail,
    scope,
  }: {
    botId: Id
    threadId: Id
    requestId: Id
    request: ApprovalPart["request"]
    detail: string
    scope?: ApprovalPart["scope"]
  }): void => {
    emit("notify.emit")?.({
      kind: "approval",
      botId,
      threadId,
      requestId,
      ...approvalSummary({ request, detail, ...(scope ? { scope } : {}) }),
    })
  }

  const prompt = ({
    botId,
    threadId,
    requestId,
    toolName,
    input,
    detail,
    scope,
  }: {
    botId: Id
    threadId: Id
    requestId: Id
    toolName: string
    input: unknown
    detail: string
    scope?: ApprovalPart["scope"]
  }): void => {
    if (toolName !== QUESTION_TOOL) {
      approval({ botId, threadId, requestId, request: "permission", detail, scope })
      return
    }
    emit("notify.emit")?.({
      kind: "question",
      botId,
      threadId,
      requestId,
      title: "Question",
      body: clip({ value: questionText(input), max: DETAIL_MAX }),
    })
  }

  const resolve = ({ requestId, resolution }: { requestId: Id; resolution: NotifyResolution }): void => {
    emit("notify.resolve")?.({ requestId, resolution })
  }

  const failure = ({
    botId,
    threadId,
    routine,
    reason,
  }: {
    botId: Id
    threadId: Id
    routine: boolean
    reason: string
  }): void => {
    emit("notify.emit")?.({
      kind: routine ? "routine-failed" : "turn-failed",
      botId,
      threadId,
      title: routine ? "Routine failed" : "Turn failed",
      body: clip({ value: reason, max: DETAIL_MAX }),
    })
  }

  const done = ({
    botId,
    threadId,
    summary,
    routine = false,
  }: {
    botId: Id
    threadId: Id
    summary: string
    routine?: boolean
  }): void => {
    emit("notify.emit")?.({
      kind: "done",
      botId,
      threadId,
      title: "Done",
      body: clip({
        value: getNotificationBody({ kind: "done", body: summary.trim() || "Finished", routine }),
        max: DETAIL_MAX,
      }),
    })
  }

  const deferred = ({
    botId,
    threadId,
    routineId,
    routineName,
    reason,
  }: {
    botId: Id
    threadId: Id | null
    routineId: Id
    routineName: string
    reason: string
  }): void => {
    emit("notify.emit")?.({
      kind: "routine-deferred",
      botId,
      threadId,
      requestId: getDeferredRequestId(routineId),
      title: `Rotina adiada: ${routineName}`,
      body: reason,
    })
  }

  return { approval, prompt, resolve, failure, done, deferred }
}

export type RuntimeNotices = ReturnType<typeof createRuntimeNotices>
