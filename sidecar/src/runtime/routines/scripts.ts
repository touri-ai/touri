import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { parseEnv } from "node:util"
import type { Kernel, Routine, RoutineRun } from "@touri/contracts"
import { redactToolText } from "@touri/contracts/redaction"
import { createGroupStore } from "../../groups/store"
import { createStreamingRedactor } from "../../kernel/redact"
import type { RuntimePersistence } from "../persistence"

const OUTPUT_LIMIT = 64 * 1024
const STDERR_LIMIT = 4096

/** Owner-authored commands run on the host, independently of provider sessions and bot permissions. */
export const createScriptRoutines = ({
  kernel,
  persistence,
  getTimeoutMs = (routine) => routine.timeoutMinutes * 60_000,
}: {
  kernel: Kernel
  persistence: RuntimePersistence
  getTimeoutMs?: (routine: Routine) => number
}) => {
  const operations = new Map<string, Promise<void>>()
  const controllers = new Map<string, AbortController>()
  let stopping = false

  const publish = (routine: Routine, run: RoutineRun): void => {
    persistence.updateRoutineRun(run)
    kernel.publish({ type: "routine.updated", routine: persistence.getRoutine(routine.id) ?? routine, lastRun: run })
  }

  const execute = async (routineId: string, scheduled: RoutineRun): Promise<void> => {
    const routine = persistence.getRoutine(routineId)
    if (!routine) return
    if (routine.kind !== "script") {
      publish(routine, { ...scheduled, status: "canceled", finishedAt: Date.now() })
      return
    }
    if (stopping) {
      publish(routine, { ...scheduled, status: "canceled", finishedAt: Date.now() })
      return
    }
    const controller = new AbortController()
    controllers.set(scheduled.id, controller)
    const running: RoutineRun = { ...scheduled, status: "running", startedAt: Date.now() }
    publish(routine, running)
    const timeout = setTimeout(() => controller.abort(), getTimeoutMs(routine))
    try {
      const result = await executeScript(kernel, routine, controller.signal)
      const failed = result.code !== 0 || controller.signal.aborted
      const text = failed
        ? `Rotina “${routine.name}” falhou (${controller.signal.aborted ? "interrompida ou tempo esgotado" : `exit ${result.code}`}):\n${result.stderr}`
        : result.stdout.trim()
      const visible = failed || (text !== "" && text !== "[SILENT]")
      const threadId = visible ? postResult(kernel, routine, text) : null
      const latest = persistence.getRoutine(routine.id)
      if (threadId && latest?.groupId === routine.groupId)
        persistence.updateRoutine({ ...latest, resultsThreadId: threadId })
      publish(routine, {
        ...running,
        status: failed ? "failed" : "succeeded",
        threadId,
        summary: failed ? redactToolText(text).slice(-STDERR_LIMIT) : null,
        finishedAt: Date.now(),
      })
      if (visible) notifyResult(kernel, routine, scheduled.id, threadId, text, failed)
    } catch {
      const text = `Rotina “${routine.name}” falhou. Confira o comando, cwd e envFile e tente novamente.`
      const threadId = (() => {
        try {
          return postResult(kernel, routine, text)
        } catch {
          return null
        }
      })()
      publish(routine, { ...running, status: "failed", summary: text, threadId, finishedAt: Date.now() })
      notifyResult(kernel, routine, scheduled.id, threadId, text, true)
    } finally {
      clearTimeout(timeout)
      controllers.delete(scheduled.id)
    }
  }

  const start = (routine: Routine, scheduled: RoutineRun): void => {
    const previous = operations.get(routine.id) ?? Promise.resolve()
    const operation = previous
      .catch(() => undefined)
      .then(() => execute(routine.id, scheduled))
      .finally(() => {
        if (operations.get(routine.id) === operation) operations.delete(routine.id)
      })
    operations.set(routine.id, operation)
  }

  // Do not replay commands which might already have produced external side effects before a crash.
  persistence
    .listRoutines()
    .filter((routine) => routine.kind === "script")
    .forEach((routine) => {
      const interrupted = persistence.getRoutineDispatchHistory(routine.id)
      if (interrupted.length > 0) persistence.updateRoutine({ ...routine, enabled: false, nextRunAt: null })
      interrupted.forEach((run) => {
        publish(routine, {
          ...run,
          status: "failed",
          summary:
            "Rotina pausada após reinício. Confira o resultado da execução interrompida antes de ativar novamente.",
          finishedAt: Date.now(),
        })
      })
    })

  return {
    start,
    hasWork: () => operations.size > 0,
    wait: async () => {
      await Promise.allSettled(operations.values())
    },
    stop: async () => {
      stopping = true
      controllers.forEach((controller) => {
        controller.abort()
      })
      await Promise.allSettled(operations.values())
    },
  }
}

export const executeScript = async (kernel: Pick<Kernel, "spawnTree">, routine: Routine, signal: AbortSignal) => {
  const environment = routine.envFile ? await getEnvironment(routine.envFile) : {}
  if (signal.aborted) throw new Error("Script canceled")
  const child = kernel.spawnTree({
    cmd: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    args: process.platform === "win32" ? ["/d", "/s", "/c", routine.command ?? ""] : ["-c", routine.command ?? ""],
    cwd: routine.cwd ?? "",
    // Never inherit provider credentials or other ambient server secrets.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...environment },
  })
  if (!child.success) throw new Error("Unable to start script")
  const stop = () => child.kill("SIGKILL")
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  try {
    await child.stdin.close().catch(() => undefined)
    const credentials = Object.entries(environment)
      .filter(
        ([key, value]) => /secret|token|password|passwd|key|credential|authorization/i.test(key) && value.length > 0,
      )
      .map(([, value]) => value)
    const [stdout, stderr, exit] = await Promise.all([
      getOutput(child.stdout, OUTPUT_LIMIT, false, signal, credentials),
      getOutput(child.stderr, STDERR_LIMIT, true, signal, credentials),
      child.exited,
    ])
    return { stdout: redactToolText(stdout), stderr: redactToolText(stderr), code: exit.code }
  } finally {
    signal.removeEventListener("abort", stop)
    // A successful shell may leave descendants holding the output pipes or still running.
    child.kill("SIGKILL")
  }
}

const getEnvironment = async (path: string): Promise<Record<string, string>> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error("envFile must be a regular file")
    const buffer = Buffer.alloc(OUTPUT_LIMIT + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > OUTPUT_LIMIT) throw new Error("envFile too large")
    return Object.fromEntries(
      Object.entries(parseEnv(buffer.subarray(0, bytesRead).toString("utf8"))).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value]],
      ),
    )
  } finally {
    await file.close()
  }
}

const getOutput = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  tail: boolean,
  signal: AbortSignal,
  credentials: readonly string[],
): Promise<string> => {
  const reader = stream.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) cancel()
  const redactor = createStreamingRedactor((text) => text, credentials)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  // Keep stream state local, masking complete credentials before either output boundary discards bytes.
  let bytes = new Uint8Array()
  const append = (text: string): void => {
    const combined = Buffer.concat([bytes, encoder.encode(text)])
    bytes = tail ? combined.subarray(-limit) : combined.subarray(0, limit)
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        append(redactor.push(decoder.decode()) + redactor.flush())
        return new TextDecoder().decode(bytes)
      }
      append(redactor.push(decoder.decode(chunk.value, { stream: true })))
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

const postResult = (kernel: Kernel, routine: Routine, output: string): string => {
  const store = kernel.services.use("store.api")
  if (!store || !routine.groupId) throw new Error("Script channel unavailable")
  const existing = routine.resultsThreadId ? store.getThread({ threadId: routine.resultsThreadId }) : null
  const created =
    existing?.groupId === routine.groupId
      ? null
      : store.createThread({
          botId: createGroupStore(kernel).get(routine.groupId)?.memberIds[0] ?? routine.botId,
          kind: "chat",
          title: routine.name,
          groupId: routine.groupId,
        })
  const thread = existing?.groupId === routine.groupId ? existing : created?.success ? created.thread : null
  if (!thread) throw new Error("Script channel unavailable")
  const inserted = store.insertMessage({
    message: {
      id: kernel.newId(),
      threadId: thread.id,
      parentId: thread.activeLeafId,
      role: "assistant",
      kind: "text",
      status: "complete",
      runId: null,
      text: output,
      parts: [{ type: "text", text: output }],
      sender: { name: routine.name, id: routine.id, kind: "integration" },
      source: "local",
    },
  })
  if (!inserted.success) throw new Error("Script output could not be saved")
  // Direct insertion is deliberate: no group turn or provider enqueue for script output.
  if (created?.success) kernel.publish({ type: "thread.updated", thread })
  return thread.id
}

const notifyResult = (
  kernel: Kernel,
  routine: Routine,
  slotId: string,
  threadId: string | null,
  output: string,
  failed: boolean,
): void => {
  kernel.services.use("notify.emit")?.({
    kind: failed ? "routine-failed" : "done",
    botId: routine.botId,
    threadId,
    requestId: failed ? `recovery:routine:${slotId}` : `script:${slotId}`,
    title: failed ? "Routine failed" : "Done",
    body: output.slice(0, 600),
  })
}
