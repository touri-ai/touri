import type { DoctorReport } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../../api/client"

export const useDoctorReport = (api: UiApi, enabled = true) => {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(false)

  const read = useCallback(
    async (refresh = false): Promise<void> => {
      const attempt = ++generation.current
      clearTimeout(timer.current)
      setError(null)
      if (refresh)
        setReport((current) => ({
          checks: current?.checks ?? [],
          checkedAt: current?.checkedAt ?? null,
          running: true,
        }))
      try {
        const next = await api.request("GET /doctor", refresh ? { refresh: true } : {})
        if (!active.current || generation.current !== attempt) return
        setReport(next)
        if (next.running)
          timer.current = setTimeout(() => {
            void read()
          }, 500)
      } catch {
        if (!active.current || generation.current !== attempt) return
        setError("Não foi possível carregar o diagnóstico. Tente novamente.")
        setReport((current) => (current ? { ...current, running: false } : null))
      }
    },
    [api],
  )

  useEffect(() => {
    active.current = enabled
    if (!enabled) return
    setReport(null)
    void read()
    const unsubscribe = api.subscribeConnection?.((connected) => {
      if (connected) void read()
    })
    // /doctor overlays observed tool health on its cached probes; ordinary reads do not rerun them.
    const unsubscribeRuns = api.subscribe(({ event }) => {
      if (event.type === "run.updated" && ["succeeded", "failed", "canceled", "interrupted"].includes(event.run.status))
        void read()
    })
    return () => {
      active.current = false
      generation.current += 1
      clearTimeout(timer.current)
      unsubscribe?.()
      unsubscribeRuns()
    }
  }, [api, enabled, read])

  return { report, error, refresh: useCallback(() => read(true), [read]) }
}
