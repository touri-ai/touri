import type { AgentImportItemSelection } from "@touri/contracts"
import { useState } from "react"
import type { TauriInvoke, UiApi } from "../../api/client"
import { BotAvatar } from "../../components/BotAvatar"
import { Badge, Button } from "../../components/Button"
import { FolderPicker } from "../../components/FolderPicker"
import { type TranslationKey, t } from "../../i18n"
import { type GuideStep, getImportedNames, getSourceLabel } from "./guide"
import type { useAgentImport } from "./useAgentImport"

export const AgentImport = ({
  step,
  imports,
  api,
  invoke,
  onManual,
  onUndo,
}: {
  step: GuideStep
  imports: ReturnType<typeof useAgentImport>
  api: UiApi
  invoke: TauriInvoke
  onManual: () => void
  onUndo: (importId: string) => Promise<void>
}) => {
  const [folderOpen, setFolderOpen] = useState(false)
  if (step === "review") return <ImportReview imports={imports} />
  if (step === "importing")
    return (
      <>
        <ImportProgress imports={imports} />
        <ImportUndo imports={imports} onUndo={onUndo} />
      </>
    )
  return (
    <>
      {imports.loading && <p role="status">{t("ob.findingSources")}</p>}
      <div className="ob-source-grid">
        {imports.sources
          .filter((source) => source.found)
          .map((source) => (
            <Button
              key={source.id}
              className="ob-choice"
              aria-pressed={imports.selected.includes(source.id)}
              onClick={() => imports.toggleSource(source.id)}
              disabled={imports.busy}
            >
              <BotAvatar bot={{ id: source.id, color: "var(--link)" }} size={32} mood="idle" />
              <strong>{getSourceLabel(source)}</strong>
              <small>{t("ob.sourceFound")}</small>
              {source.summary && <span>{t("ob.sourceCount", { count: source.summary.agents })}</span>}
            </Button>
          ))}
        {sourceActions.map((source) => (
          <Button
            key={source.id}
            className="ob-choice"
            onClick={() => (source.id === "folder" ? setFolderOpen(true) : onManual())}
          >
            <span aria-hidden="true">{source.icon}</span>
            <strong>{t(source.label)}</strong>
            <small>{t(source.detail)}</small>
          </Button>
        ))}
      </div>
      <ImportUndo imports={imports} onUndo={onUndo} />
      {imports.error && (
        <div className="ob-notice">
          <p role="alert">{imports.error}</p>
          <Button onClick={() => void imports.refresh()}>{t("ob.retry")}</Button>
        </div>
      )}
      {folderOpen && (
        <FolderPicker
          api={api}
          invokeCommand={invoke}
          onClose={() => setFolderOpen(false)}
          onSelect={(folder) => {
            imports.addFolder(folder.path)
            setFolderOpen(false)
          }}
        />
      )}
    </>
  )
}
export const ManualImport = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  const [notice, setNotice] = useState("")
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t("ob.exportRequest"))
      setNotice(t("ob.copied"))
    } catch {
      setNotice(t("ob.selectCopy"))
    }
  }
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      onChange(text.slice(0, 65_536))
      setNotice("")
    } catch {
      setNotice(t("ob.pasteHere"))
    }
  }
  return (
    <>
      <pre className="ob-export-request">{t("ob.exportRequest")}</pre>
      <div className="ob-inline">
        <Button onClick={() => void copy()}>{t("ob.copyRequest")}</Button>
        <Button onClick={() => void paste()}>{t("ob.pasteResponse")}</Button>
      </div>
      <label className="ob-field">
        {t("ob.exportResponse")}
        <textarea
          value={value}
          maxLength={65_536}
          rows={7}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="ob-field">
        {t("ob.chooseExport")}
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            if (file.size > 65_536) {
              setNotice(t("ob.exportTooLarge"))
              return
            }
            void file
              .text()
              .then(onChange)
              .catch(() => setNotice(t("ob.previewError")))
          }}
        />
      </label>
      {notice && <p role="status">{notice}</p>}
    </>
  )
}
const ImportReview = ({ imports }: { imports: ReturnType<typeof useAgentImport> }) => (
  <div className="ob-import-list">
    {imports.previews.map(({ preview }) => (
      <section key={preview.previewId}>
        {preview.agents.length === 0 && <p>{t("ob.noAgents")}</p>}
        {preview.agents.map((agent) => {
          const selection = imports.selection[preview.previewId]?.[agent.key]
          return (
            <article key={agent.key} className="ob-import-agent">
              <div className="ob-inline">
                <BotAvatar bot={{ id: agent.key, avatarSeed: agent.key, color: null }} size={32} mood="idle" />
                <strong>{agent.suggestedBotName}</strong>
                <label className="ob-agent-check">
                  <input
                    type="checkbox"
                    aria-label={t("ob.selectAgent", { name: agent.suggestedBotName })}
                    checked={Boolean(selection && Object.values(selection).some(Boolean))}
                    onChange={(event) => imports.toggleAgent(preview.previewId, agent.key, event.target.checked)}
                  />
                  {t("ob.includeAgent")}
                </label>
              </div>
              {agent.role && <p>{agent.role}</p>}
              <div className="ob-selection-grid">
                {importItems.map(({ key, label }) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={selection?.[key] ?? false}
                      onChange={() => imports.toggleItem(preview.previewId, agent.key, key)}
                    />
                    {t(label)} <small>({getItemCount(key, agent)})</small>
                  </label>
                ))}
              </div>
              {agent.routines.length > 0 && <Badge tone="info">{t("ob.routinesPaused")}</Badge>}
              {agent.integrations.length > 0 && (
                <p className="ob-muted">{t("ob.reconnectNames", { names: agent.integrations.join(", ") })}</p>
              )}
            </article>
          )
        })}
        <p className="ob-notice">
          {t("ob.excluded", { secrets: preview.excluded.secrets, files: preview.excluded.files })}
        </p>
      </section>
    ))}
  </div>
)
const importItems: { key: keyof AgentImportItemSelection; label: TranslationKey }[] = [
  { key: "instructions", label: "ob.instructions" },
  { key: "skills", label: "ob.skills" },
  { key: "memories", label: "ob.memories" },
  { key: "routines", label: "ob.routines" },
]
const getItemCount = (
  key: keyof AgentImportItemSelection,
  agent: ReturnType<typeof useAgentImport>["previews"][number]["preview"]["agents"][number],
): number => {
  if (key === "instructions") return agent.instructions.files
  if (key === "memories") return agent.memories
  return agent[key].length
}
const ImportProgress = ({ imports }: { imports: ReturnType<typeof useAgentImport> }) => (
  <div className="ob-import-list" aria-live="polite">
    {imports.previews.flatMap(({ preview }) =>
      preview.agents
        .filter((agent) => Object.values(imports.selection[preview.previewId]?.[agent.key] ?? {}).some(Boolean))
        .map((agent) => {
          const importId = imports.importIds[preview.previewId]
          const progress = imports.progress.find((item) => item.importId === importId && item.agentKey === agent.key)
          const done = imports.results.some(
            (result) => result.importId === importId && result.bots.some((bot) => bot.agentKey === agent.key),
          )
          const failed = Boolean(imports.error) && !imports.busy
          const mood = getProgressMood(progress?.step, done, failed)
          return (
            <div key={`${preview.previewId}-${agent.key}`} className="ob-import-agent">
              <div className="ob-inline">
                <BotAvatar bot={{ id: agent.key, avatarSeed: agent.key, color: null }} size={32} mood={mood} />
                <strong>{agent.suggestedBotName}</strong>
                <span>{getProgressLabel(done, failed)}</span>
              </div>
              {progress && (
                <progress aria-label={agent.suggestedBotName} value={progress.done} max={Math.max(1, progress.total)} />
              )}
            </div>
          )
        }),
    )}
    {imports.results.some((result) => result.pausedRoutines > 0) && <p>{t("ob.routinesPaused")}</p>}
  </div>
)
const getProgressMood = (step: string | undefined, done: boolean, failed: boolean) => {
  if (done || step === "done") return "responded"
  if (failed || step === "failed") return "failed"
  return "working"
}

const sourceActions = [
  { id: "folder", label: "ob.folderSource", detail: "ob.pickFolder", icon: "＋" },
  { id: "manual", label: "ob.manualSource", detail: "ob.copyAndPaste", icon: "↗" },
] as const

const getProgressLabel = (done: boolean, failed: boolean): string => {
  if (done) return t("ob.importDone")
  if (failed) return t("ob.importFailed")
  return t("ob.importWorking")
}

const ImportUndo = ({
  imports,
  onUndo,
}: {
  imports: ReturnType<typeof useAgentImport>
  onUndo: (importId: string) => Promise<void>
}) => {
  if (!imports.results.length) return null
  return (
    <div className="ob-inline">
      {imports.results.map((result) => (
        <Button
          key={result.importId}
          variant="quiet"
          className="ob-import-undo"
          disabled={imports.busy}
          onClick={() => void onUndo(result.importId)}
        >
          {t("ob.undoImportNamed", { names: getImportedNames(imports, result.importId) })}
        </Button>
      ))}
    </div>
  )
}
