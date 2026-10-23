import type { Run, RunActivity } from "@touri/contracts"
import type { ChildProcess } from "./provider-io"
import { getProviderProcessAlive } from "./provider-processes"

export const RUN_EVENT_TIMEOUT_MS = 10 * 60_000
export const RUN_CANCEL_GRACE_MS = 1_000

type ProcessObservation = { child: ChildProcess; exited: boolean }

export const createRunSupervision = (getProcessAlive = getProviderProcessAlive) => {
  // This lifecycle owner replaces observations at I/O boundaries; readers never change them.
  const processes = new Map<string, ProcessObservation>()
  const events = new Map<string, number>()

  const observeProcess = (runId: string, child: ChildProcess): void => {
    const observation = { child, exited: false }
    processes.set(runId, observation)
    void child.exited.then(
      () => markExited(runId, observation),
      () => markExited(runId, observation),
    )
  }

  const markExited = (runId: string, observation: ProcessObservation): void => {
    if (processes.get(runId) !== observation) return

    processes.set(runId, Object.assign({}, observation, { exited: true }))
  }

  const recordEvent = (runId: string, at: number): void => {
    events.set(runId, at)
  }

  const getActivity = async (run: Run, now: number, waitingForPerson = false): Promise<RunActivity> => {
    const lastEventAt = events.get(run.id) ?? null
    if (!["queued", "starting", "running"].includes(run.status))
      return { active: false, processAlive: null, lastEventAt, staleReason: null }
    if (run.status === "queued") return { active: true, processAlive: null, lastEventAt, staleReason: null }

    const observation = processes.get(run.id)
    const processAlive = await getObservationAlive(observation)
    const lastActivityAt = lastEventAt ?? run.startedAt ?? run.queuedAt
    const expired = !waitingForPerson && now - lastActivityAt >= RUN_EVENT_TIMEOUT_MS
    const staleReason = processAlive === false ? "process_exited" : expired ? "event_timeout" : null

    return { active: staleReason === null, processAlive, lastEventAt, staleReason }
  }

  const getObservationAlive = async (observation: ProcessObservation | undefined): Promise<boolean | null> => {
    if (!observation) return null
    if (observation.exited) return false
    if (observation.child.target === "remote") return null

    return getProcessAlive(observation.child.pid)
  }

  const hasProcess = (runId: string): boolean => processes.has(runId)

  const stopProcess = async (runId: string): Promise<void> => {
    const observation = processes.get(runId)
    if (!observation) return

    // An exited leader can leave helpers in its owned group when the exit notification was missed.
    try {
      observation.child.kill("SIGKILL")
    } catch (error) {
      // The leader can exit between the liveness probe and signaling its group.
      if ((await getObservationAlive(observation)) === false) return
      throw error
    }
  }

  const forgetRun = (runId: string): void => {
    processes.delete(runId)
    events.delete(runId)
  }

  return { observeProcess, recordEvent, getActivity, hasProcess, stopProcess, forgetRun }
}
