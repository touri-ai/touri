import type {
  AgentImportItemSelection,
  AgentImportPreview,
  AgentImportProgress,
  AgentImportResult,
  AgentImportSource,
} from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../../api/client"
import { ApiError } from "../../errors"
import { t } from "../../i18n"
import { getImportProgress, getToggle } from "./guide"

export type ImportPreview = { sourceId: string; preview: AgentImportPreview }
export type ImportSelection = Record<string, Record<string, AgentImportItemSelection>>
export const useAgentImport = (api: UiApi) => {
  const [sources, setSources] = useState<AgentImportSource[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [previews, setPreviews] = useState<ImportPreview[]>([])
  const [selection, setSelection] = useState<ImportSelection>({})
  const [results, setResults] = useState<AgentImportResult[]>([])
  const [progress, setProgress] = useState<AgentImportProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const applying = useRef(false)
  const completed = useRef<Set<string>>(new Set())
  const activeKeys = useRef<string[]>([])
  const refresh = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setLoading(true)
    setError(null)
    try {
      const result = await api.request("GET /api/v1/import/sources", {}, {}, { signal: current.signal })
      if (current.signal.aborted) return
      setSources(result.sources.slice(0, 20))
      setSelected(
        result.sources
          .filter((source) => source.found)
          .slice(0, 20)
          .map((source) => source.id),
      )
    } catch {
      if (!current.signal.aborted) setError(t("ob.sourcesError"))
    } finally {
      if (!current.signal.aborted) setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void refresh()
    return () => controller.current?.abort()
  }, [refresh])
  useEffect(
    () =>
      api.subscribe(({ event }) => {
        if (!applying.current) return
        const update = getImportProgress(event)
        if (!update || !activeKeys.current.includes(update.agentKey)) return
        setProgress((previous) => [...previous.filter((item) => item.agentKey !== update.agentKey), update].slice(-100))
      }),
    [api],
  )
  const addFolder = (path: string) => {
    const source: AgentImportSource = {
      id: `folder:${path}`,
      kind: "folder",
      label: t("ob.folderSource"),
      found: true,
      path,
    }
    setSources((previous) => [...previous.filter((item) => item.id !== source.id), source].slice(-20))
    setSelected((previous) => Array.from(new Set([...previous, source.id])))
  }
  const savePreviews = (next: ImportPreview[]) => {
    setPreviews(next)
    setSelection(
      Object.fromEntries(
        next.map(({ preview }) => [
          preview.previewId,
          Object.fromEntries(
            preview.agents.map((agent) => [
              agent.key,
              { instructions: true, skills: true, memories: true, routines: true },
            ]),
          ),
        ]),
      ),
    )
  }
  const previewSources = async (manual?: string): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      if (manual !== undefined) {
        if (new TextEncoder().encode(manual).byteLength > 65_536) {
          setError(t("ob.exportTooLarge"))
          return false
        }
        const payload: unknown = JSON.parse(manual)
        const preview = await api.request("POST /api/v1/import/preview", { source: "manual", payload })
        savePreviews([{ sourceId: "manual", preview }])
        return true
      }
      const next = await Promise.all(
        sources
          .filter((source) => selected.includes(source.id))
          .map(async (source) => ({
            sourceId: source.id,
            preview: await api.request("POST /api/v1/import/preview", {
              source: source.kind,
              ...(source.path ? { path: source.path } : {}),
            }),
          })),
      )
      savePreviews(next)
      return next.length > 0
    } catch {
      setError(t("ob.previewError"))
      return false
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<boolean> => {
    if (applying.current) return false
    applying.current = true
    activeKeys.current = previews.flatMap(({ preview }) => preview.agents.map((agent) => agent.key))
    setBusy(true)
    setError(null)
    try {
      // Each preview is a separate server transaction; retain successes when another source fails.
      for (const { preview } of previews) {
        if (completed.current.has(preview.previewId)) continue
        const select = Object.fromEntries(
          Object.entries(selection[preview.previewId] ?? {}).filter(([, item]) => Object.values(item).some(Boolean)),
        )
        if (!Object.values(select).some((item) => Object.values(item).some(Boolean))) continue
        const result = await api.request("POST /api/v1/import/apply", { previewId: preview.previewId, select })
        completed.current.add(preview.previewId)
        setResults((previous) => [...previous, result])
      }
      return true
    } catch (error) {
      setError(t(error instanceof ApiError && error.status === 410 ? "ob.previewExpired" : "ob.applyError"))
      return false
    } finally {
      applying.current = false
      setBusy(false)
    }
  }
  const toggleItem = (previewId: string, key: string, item: keyof AgentImportItemSelection) =>
    setSelection((previous) => {
      const agent = previous[previewId]?.[key]
      if (!agent) return previous
      return { ...previous, [previewId]: { ...previous[previewId], [key]: { ...agent, [item]: !agent[item] } } }
    })
  const toggleAgent = (previewId: string, key: string, enabled: boolean) =>
    setSelection((previous) => ({
      ...previous,
      [previewId]: {
        ...previous[previewId],
        [key]: { instructions: enabled, skills: enabled, memories: enabled, routines: enabled },
      },
    }))
  return {
    sources,
    selected,
    previews,
    selection,
    selectionCount: Object.values(selection).reduce(
      (total, agents) => total + Object.values(agents).filter((item) => Object.values(item).some(Boolean)).length,
      0,
    ),
    progress,
    results,
    loading,
    busy,
    error,
    refresh,
    addFolder,
    previewSources,
    apply,
    clearPreview: () => {
      setPreviews([])
      setSelection({})
      setError(null)
    },
    toggleItem,
    toggleAgent,
    toggleSource: (id: string) => setSelected((previous) => getToggle(previous, id)),
  }
}
