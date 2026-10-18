import type { RecoveryTask } from "@touri/contracts"
import { createContext, useCallback, useEffect, useState } from "react"
import type { UiApi } from "./api/client"

export const RecoveryTasksContext = createContext<RecoveryTask[]>([])

export const useRecoveryTasks = (api: UiApi | null) => {
  const [tasks, setTasks] = useState<RecoveryTask[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [refreshRequest, setRefreshRequest] = useState(0)
  const reload = useCallback(() => setRefreshRequest((current) => current + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry explicitly refreshes the snapshot and subscription.
  useEffect(() => {
    setLoading(true)
    if (!api) {
      setTasks([])
      return
    }
    let active = true
    let revision = 0
    const refresh = async () => {
      const attempt = ++revision
      try {
        const response = await api.request("GET /recovery", {})
        if (!active || attempt !== revision) return
        setTasks(response.tasks)
        setError(null)
      } catch (reason) {
        if (active && attempt === revision) setError(reason)
      } finally {
        if (active && attempt === revision) setLoading(false)
      }
    }
    const unsubscribe = api.subscribe(({ event }) => {
      if (event.type === "notification.resolved")
        setTasks((current) =>
          current.map((task) =>
            task.notification.id === event.notification.id ? { ...task, notification: event.notification } : task,
          ),
        )
      if (
        event.type === "notification.resolved" ||
        event.type === "notification.created" ||
        event.type === "routine.updated" ||
        event.type === "process.updated" ||
        (event.type === "run.updated" && ["failed", "interrupted", "succeeded", "queued"].includes(event.run.status))
      )
        void refresh()
    })
    void refresh()
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, refreshRequest])

  const dismiss = useCallback(
    async (task: RecoveryTask, acknowledgeKeys: string[]) => {
      if (!api) return
      const response = await api.request("POST /recovery/:id/dismiss", { acknowledgeKeys }, { id: task.id })
      setTasks(response.tasks)
    },
    [api],
  )

  return { tasks, error, loading, dismiss, reload }
}
