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
/** An applied import keeps its agents' names, so it stays listed and named after another preview replaces it. */
export type ImportedResult = AgentImportResult & { agents: { key: string; name: string }[] }
export const useAgentImport = (api: UiApi) => {
  const [sources, setSources] = useState<AgentImportSource[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [previews, setPreviews] = useState<ImportPreview[]>([])
  const [selection, setSelection] = useState<ImportSelection>({})
  const [results, setResults] = useState<ImportedResult[]>([])
  const [importIds, setImportIds] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<AgentImportProgress[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const applying = useRef(false)
  const completed = useRef<Set<string>>(new Set())
  const activeKeys = useRef<string[]>([])
  const activePreview = useRef("")
  const progressOwners = useRef(new Map<string, string>())
  const rememberImport = (previewId: string, importId: string) => {
    progressOwners.current.set(importId, previewId)
    setImportIds((previous) => ({ ...previous, [previewId]: importId }))
  }
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
        const previewId = progressOwners.current.get(update.importId) ?? activePreview.current
        if (!previewId) return
        progressOwners.current.set(update.importId, previewId)
        setImportIds((previous) => ({ ...previous, [previewId]: update.importId }))
        setProgress((previous) =>
          [
            ...previous.filter((item) => item.importId !== update.importId || item.agentKey !== update.agentKey),
            update,
          ].slice(-100),
        )
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
    const chosen = sources.filter((source) => selected.includes(source.id))
    // The server keeps three preview tickets; a larger batch evicts its own first ticket.
    if (manual === undefined && chosen.length > 3) {
      setError(t("ob.sourcesLimit"))
      return false
    }
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
        chosen.map(async (source) => ({
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
        activePreview.current = preview.previewId
        activeKeys.current = Object.keys(select)
        const result = await api.request("POST /api/v1/import/apply", { previewId: preview.previewId, select })
        const importedKeys = new Set(result.bots.map((bot) => bot.agentKey))
        const agents = preview.agents
          .filter((agent) => importedKeys.has(agent.key))
          .map((agent) => ({ key: agent.key, name: agent.suggestedBotName }))
        rememberImport(preview.previewId, result.importId)
        completed.current.add(preview.previewId)
        setResults((previous) => [...previous, { ...result, agents }])
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
  const undo = async (importId: string): Promise<boolean> => {
    if (applying.current) return false
    applying.current = true
    setBusy(true)
    setError(null)
    try {
      await api.request("POST /api/v1/import/undo", { importId })
      const previewIds = Object.entries(importIds)
        .filter(([, id]) => id === importId)
        .map(([previewId]) => previewId)
      completed.current = new Set(Array.from(completed.current).filter((id) => !previewIds.includes(id)))
      progressOwners.current.delete(importId)
      setResults((previous) => previous.filter((result) => result.importId !== importId))
      setProgress((previous) => previous.filter((item) => item.importId !== importId))
      setPreviews((previous) => previous.filter(({ preview }) => !previewIds.includes(preview.previewId)))
      setSelection((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([id]) => !previewIds.includes(id))),
      )
      setImportIds((previous) => Object.fromEntries(Object.entries(previous).filter(([, id]) => id !== importId)))
      return true
    } catch {
      setError(t("ob.undoError"))
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
    selectionCount:
      new Set(results.flatMap((result) => result.bots.map((bot) => bot.botId))).size +
      Object.entries(selection)
        .filter(([previewId]) => !completed.current.has(previewId))
        .reduce(
          (total, [, agents]) =>
            total + Object.values(agents).filter((item) => Object.values(item).some(Boolean)).length,
          0,
        ),
    progress,
    importIds,
    results,
    loading,
    busy,
    error,
    refresh,
    addFolder,
    previewSources,
    apply,
    undo,
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
