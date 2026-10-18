import type { Bot, BotGroup, Id, MachineState, Message, Routine } from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { machineStateForDisplay } from "../machineState"
import { useHost } from "../useHost"
import { BotAvatar } from "./BotAvatar"
import { BotComputer } from "./BotComputer"
import { BotDetails } from "./BotDetails"
import { BotLibrary } from "./BotLibrary"
import { ErrorText } from "./ErrorDetails"
import { GoalPanel } from "./GoalPanel"
import { useSegmentedControl } from "./Motion"
import { PanelIcon } from "./PanelIcon"
import "./bot-panel.css"

const tabs = ["details", "library", "computer"] as const
const tabLabels = { details: "Bot details", library: "Bot library", computer: "Bot computer" } as const
export const BotPanel = ({
  api,
  groups = [],
  onGroup,
  bot,
  machine: rawMachine,
  routines,
  paused,
  activeTurns = false,
  expanded,
  onExpand,
  onWindow,
  onClose,
  onSettings,
  onRoutines,
  onModel,
  onPermissions,
  onRole,
  onPreview,
  libraryRequest,
  computerTabRequest = 0,
  goalThreadId,
  goalRequest,
  goalBusy = false,
  goalRefreshRequest = 0,
  onGoalChange,
}: {
  api: UiApi
  onPreview?: () => void
  groups?: BotGroup[]
  onGroup?: (group: BotGroup) => void
  bot: Bot
  machine?: MachineState | undefined
  routines: Routine[]
  paused: boolean
  activeTurns?: boolean
  expanded: boolean
  onExpand: () => void
  onWindow: () => Promise<void>
  onClose: () => void
  onSettings: () => void
  onRoutines: () => void
  onModel?: () => void
  onPermissions: () => void
  onRole: (roleLine: string | null) => Promise<void>
  libraryRequest?: { path: string; request: number } | undefined
  computerTabRequest?: number
  goalThreadId?: Id | undefined
  goalRequest?: Message | undefined
  goalBusy?: boolean
  goalRefreshRequest?: number
  onGoalChange?: () => void
}) => {
  const host = useHost(api)
  const [tab, setTab] = useState<(typeof tabs)[number]>("details")
  useEffect(() => {
    if (computerTabRequest) setTab("computer")
  }, [computerTabRequest])
  useEffect(() => {
    if (libraryRequest) setTab("library")
  }, [libraryRequest])
  const [role, setRole] = useState(bot.roleLine ?? "")
  useEffect(() => {
    setRole(bot.roleLine ?? "")
  }, [bot.roleLine])
  const openComputer = useCallback(() => setTab("computer"), [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRole = useRef(false)
  const tablist = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useSegmentedControl(tablist, tab)
  const machine = machineStateForDisplay(rawMachine)
  const saveRole = async () => {
    if (cancelRole.current) {
      cancelRole.current = false
      return
    }
    if (role.trim() === (bot.roleLine ?? "") || saving) return
    setSaving(true)
    setError(null)
    try {
      await onRole(role.trim() || null)
    } catch (reason) {
      setError(userFacingError(reason))
    } finally {
      setSaving(false)
    }
  }
  return (
    <aside
      className={`bot-panel ${expanded ? "bot-panel-expanded" : ""} ${tab === "computer" ? "bot-panel-computer" : ""}`}
      id="bot-panel"
      aria-label={t("Panel for bot", { name: bot.name })}
    >
      <div className="bot-panel-top">
        <span>
          {t("Your bot")} <span className="panel-bot-name">· {bot.name}</span>
        </span>
        <button className="toolbar-icon" type="button" aria-label={t("Close bot panel")} onClick={onClose}>
          <PanelIcon name="close" />
        </button>
      </div>
      <header className="bot-panel-identity">
        <BotAvatar bot={bot} size={tab === "computer" ? 48 : 72} />
        <h2>{bot.name}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void saveRole()
          }}
        >
          <label className="visually-hidden" htmlFor={`panel-role-${bot.id}`}>
            {t("Bot job")}
          </label>
          <input
            id={`panel-role-${bot.id}`}
            value={role}
            maxLength={160}
            placeholder={t("Add a job")}
            disabled={saving}
            onChange={(event) => setRole(event.target.value)}
            onBlur={() => void saveRole()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelRole.current = true
                setRole(bot.roleLine ?? "")
                event.currentTarget.blur()
              }
            }}
          />
          <button className="visually-hidden" type="submit">
            {t("Save job")}
          </button>
        </form>
        {saving && <small role="status">{t("Saving job…")}</small>}
        {error && (
          <div className="warning-callout" role="alert">
            <ErrorText text={error} />
          </div>
        )}
      </header>
      <div className="bot-panel-tabs motion-segments" role="tablist" aria-label={t("Bot panel")} ref={tablist}>
        {tabs.map((name, index) => (
          <button
            type="button"
            key={name}
            role="tab"
            id={`bot-tab-${index}`}
            aria-controls={`bot-tabpanel-${index}`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => {
              setTab(name)
              if (body.current) body.current.scrollTop = 0
              if (expanded && name !== "computer") onExpand()
            }}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
              if (!direction && event.key !== "Home" && event.key !== "End") return
              event.preventDefault()
              const next =
                event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + direction + tabs.length) % tabs.length
              const button = tablist.current?.querySelectorAll<HTMLButtonElement>("button")[next]
              button?.click()
              button?.focus()
            }}
          >
            {t(tabLabels[name])}
          </button>
        ))}
      </div>
      <div
        ref={body}
        className="bot-panel-body"
        role="tabpanel"
        id={`bot-tabpanel-${tabs.indexOf(tab)}`}
        aria-labelledby={`bot-tab-${tabs.indexOf(tab)}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are focusable per the ARIA tabs keyboard pattern
        tabIndex={0}
      >
        {tab === "details" && (
          <div className="bot-details">
            <BotDetails bot={bot} host={host} onSettings={onSettings} onModel={onModel} onPermissions={onPermissions}>
              {onPreview && (
                <button className="button button-quiet" type="button" onClick={onPreview}>
                  {t("Project preview")}
                </button>
              )}
            </BotDetails>
            {goalThreadId && (
              <GoalPanel
                key={goalThreadId}
                api={api}
                threadId={goalThreadId}
                bot={bot}
                request={goalRequest}
                busy={goalBusy}
                surface="entry"
                refreshRequest={goalRefreshRequest}
                onChange={onGoalChange}
              />
            )}
            <section className="bot-details-section">
              <h3>{t("Bot groups")}</h3>
              {groups.length ? (
                groups.map((group) => (
                  <button type="button" key={group.id} className="button button-quiet" onClick={() => onGroup?.(group)}>
                    {group.name}
                    {group.coordinatorBotId === bot.id ? t("Group coordinator suffix") : ""}
                  </button>
                ))
              ) : (
                <p className="muted-copy">{t("This bot has no groups yet.")}</p>
              )}
            </section>
            <section className="bot-details-section" aria-labelledby={`bot-routines-${bot.id}`}>
              <div className="library-heading">
                <h3 id={`bot-routines-${bot.id}`}>{t("Bot routines")}</h3>
                <span className="count-pill" title={t("Bot routine count", { count: routines.length })}>
                  {routines.length}
                </span>
              </div>
              {routines.length ? (
                <ul className="bot-routines">
                  {routines.map((routine) => (
                    <li key={routine.id}>
                      <PanelIcon name="clock" />
                      <div>
                        <strong>{routine.name}</strong>
                        <small>
                          {routine.enabled
                            ? routine.nextRunAt
                              ? t("Next routine time", {
                                  time: new Date(routine.nextRunAt).toLocaleString("pt-BR", {
                                    timeZone: routine.timezone,
                                    dateStyle: "short",
                                    timeStyle: "short",
                                  }),
                                  timezone: routine.timezone,
                                })
                              : t("Waiting for the next schedule")
                            : t("Routine paused")}
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="bot-panel-empty">
                  <PanelIcon name="clock" />
                  <strong>{t("No scheduled routines")}</strong>
                  <p>{t("Set a routine for recurring tasks.")}</p>
                  <button className="button button-quiet" type="button" onClick={onRoutines}>
                    {t("Configure routines")}
                  </button>
                </div>
              )}
            </section>
          </div>
        )}
        {tab === "library" && (
          <BotLibrary key={bot.id} api={api} bot={bot} request={libraryRequest} onComputer={openComputer} />
        )}
        {tab === "computer" && (
          <BotComputer
            key={bot.id}
            api={api}
            bot={bot}
            machine={machine}
            paused={paused}
            activeTurns={activeTurns}
            expanded={expanded}
            onExpand={onExpand}
            onWindow={onWindow}
            onPermissions={onPermissions}
            onChat={onClose}
            onFiles={() => setTab("library")}
          />
        )}
      </div>
    </aside>
  )
}
