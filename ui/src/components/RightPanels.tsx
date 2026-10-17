import type { BrowserTabInfo, Id, ProcessRunState, ProcessSpec, Project } from "@touri/contracts"
import { useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { ApiError, userFacingError } from "../errors"
import { statusLabel, t } from "../i18n"

type ProcessEntry = { spec: ProcessSpec; run: ProcessRunState | null }

type ProcessPanelProps = {
  project: Project | null
  processes: Array<ProcessEntry>
  onStart: (processId: Id) => Promise<void>
  onStop: (processId: Id) => Promise<void>
}

export const ProcessPanel = ({ project, processes, onStart, onStop }: ProcessPanelProps) => (
  <div className="right-panel-content">
    <div className="panel-heading-row">
      <div>
        <p className="eyebrow">{t("supervised locally")}</p>
        <h3>{t("Processes")}</h3>
      </div>
      <span className="count-pill">{processes.length}</span>
    </div>
    {!project && <p className="muted-copy">{t("Connect a project to supervise its dev servers.")}</p>}
    {project && (
      <div className="project-chip">
        <span className="folder-icon">⌁</span>
        <span>
          <strong>{project.name}</strong>
          <small>{project.path}</small>
        </span>
      </div>
    )}
    <div className="process-list">
      {processes.map((entry) => {
        const status = entry.run?.status ?? "not-started"
        const running = status === "starting" || status === "running" || status === "ready"
        return (
          <article className="process-card" key={entry.spec.id}>
            <div className="process-card-top">
              <span
                className={`status-dot ${status === "ready" ? "status-green" : status === "crashed" ? "status-red" : "status-muted"}`}
              />
              <strong>{entry.spec.name}</strong>
              <span className="process-status">{statusLabel(status)}</span>
            </div>
            <code>{entry.spec.command}</code>
            {entry.spec.previewPort && <span className="port-chip">localhost:{entry.spec.previewPort}</span>}
            <div className="process-actions">
              {running ? (
                <button type="button" className="text-button" onClick={() => void onStop(entry.spec.id)}>
                  {t("Stop")}
                </button>
              ) : (
                <button type="button" className="text-button text-brand" onClick={() => void onStart(entry.spec.id)}>
                  {t("Start")}
                </button>
              )}
              <button type="button" className="text-button">
                Logs
              </button>
            </div>
          </article>
        )
      })}
      {project && processes.length === 0 && (
        <div className="empty-panel">
          <span>⌁</span>
          <p>{t("No process definitions yet.")}</p>
          <small>{t("Your teammate can define one with process_define.")}</small>
        </div>
      )}
    </div>
  </div>
)

type BrowserPanelProps = {
  tabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>
  botId: Id | null
  api: UiApi
  onNotice: (message: string) => void
}

export const BrowserPanel = ({ tabs, botId, api, onNotice }: BrowserPanelProps) => {
  const [busyTab, setBusyTab] = useState<string | null>(null)
  const [liveTabs, setLiveTabs] = useState<{ botId: Id | null; tabs: BrowserPanelProps["tabs"] }>()
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const response = await api.request("GET /browser/tabs", botId ? { botId } : {})
        if (active) setLiveTabs({ botId, tabs: response.tabs })
      } catch {
        // Preserve the last snapshot during a brief transport failure.
      } finally {
        if (active) timer = setTimeout(refresh, 3_000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, botId])
  const ownedTabs = (liveTabs?.botId === botId ? liveTabs.tabs : tabs).filter(
    (tab) => !botId || tab.ownerBotId === botId,
  )
  const toggleTakeover = async (tab: BrowserTabInfo & { ownerBotId: Id | null }): Promise<void> => {
    setBusyTab(tab.tabId)
    try {
      await api.request("POST /browser/tabs/:id/takeover", { hold: !tab.heldByUser }, { id: tab.tabId })
      onNotice(
        tab.heldByUser ? t("Handed the tab back to the teammate.") : t("The tab is held by you; the agent is paused."),
      )
    } catch (error) {
      const detail = error instanceof ApiError && error.message ? userFacingError(error) : null
      onNotice(detail ?? t("The agent browser is not connected yet."))
    } finally {
      setBusyTab(null)
    }
  }
  return (
    <div className="right-panel-content">
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">{t("headed Chrome")}</p>
          <h3>{t("Browser")}</h3>
        </div>
        <span className="count-pill">{ownedTabs.length}</span>
      </div>
      <p className="muted-copy">{t("A touri-owned profile keeps agent tabs separate from your personal Chrome.")}</p>
      <div className="browser-list">
        {ownedTabs.map((tab) => (
          <article className="browser-card" key={tab.tabId}>
            <div className="browser-thumb">
              <span>◌</span>
              <small>{tab.title}</small>
            </div>
            <div className="browser-card-meta">
              <strong>{tab.title}</strong>
              <span>{tab.url}</span>
              <div>
                <span className={`state-label ${tab.heldByUser ? "state-held" : ""}`}>
                  {tab.heldByUser ? t("held by you") : statusLabel(tab.state)}
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busyTab === tab.tabId}
                  onClick={() => void toggleTakeover(tab)}
                >
                  {tab.heldByUser ? t("Hand back") : t("Take over")}
                </button>
              </div>
            </div>
          </article>
        ))}
        {ownedTabs.length === 0 && (
          <div className="empty-panel">
            <span>◎</span>
            <p>{t("No tabs for this teammate.")}</p>
            <small>{t("Ask the teammate to open a page with browser_open.")}</small>
          </div>
        )}
      </div>
    </div>
  )
}

type SecretsPanelProps = {
  project: Project | null
  api: UiApi
  invokeSecret: (account: string, value: string) => Promise<boolean>
  onNotice: (message: string) => void
  onSaved?: () => void
}

export const SecretsPanel = ({ project, api, invokeSecret, onNotice, onSaved }: SecretsPanelProps) => {
  const nameId = useId()
  const valueId = useId()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [saving, setSaving] = useState(false)
  const [names, setNames] = useState<Array<string>>([])

  const save = async (): Promise<void> => {
    if (!project || !name.trim() || !value) return
    setSaving(true)
    const account = `${project.id}/${name.trim().toUpperCase()}`
    try {
      const saved = await invokeSecret(account, value)
      if (!saved) throw new Error(t("Native secret storage unavailable"))
      await api.request(
        "PUT /projects/:id/secrets/:name",
        { usage: { env: true, browser: false } },
        { id: project.id, name: name.trim().toUpperCase() },
      )
      setNames((current) => [...new Set([...current, name.trim().toUpperCase()])])
      onSaved?.()
      setName("")
      setValue("")
      onNotice(t("Secret saved to the macOS Keychain. The value never passed through the sidecar."))
    } catch {
      onNotice(t("Secret storage is unavailable in this build; nothing was sent to the sidecar."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="secrets-panel">
      <div className="panel-heading-row">
        <div>
          <p className="eyebrow">{t("Keychain-backed")}</p>
          <h3>{t("Secrets")}</h3>
        </div>
      </div>
      <p className="muted-copy">
        {t("Values are written through native IPC only. Agents see names and usage, never values.")}
      </p>
      <div className="secret-list">
        {names.map((secret) => (
          <span className="secret-chip" key={secret}>
            ◈ {secret}
            <small>ambiente</small>
          </span>
        ))}
      </div>
      <div className="secret-form">
        <label htmlFor={nameId}>{t("Name")}</label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="MONGO_URI"
          autoCapitalize="characters"
        />
        <label htmlFor={valueId}>{t("Value")}</label>
        <input
          id={valueId}
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("stored securely")}
        />
        <button
          type="button"
          className="button button-dark"
          disabled={!project || !name || !value || saving}
          onClick={() => void save()}
        >
          {saving ? t("Saving…") : t("Save to Keychain")}
        </button>
      </div>
      {!project && <p className="muted-copy">{t("Connect a project first.")}</p>}
    </div>
  )
}
