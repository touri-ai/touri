import type { AvatarIdentity } from "@touri/contracts/avatar"
import { type ReactNode, useEffect, useState } from "react"
import { type Locale, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import { Badge } from "./Button"

export const BrowserLiveHeader = ({
  bot,
  botName,
  waiting,
  requesterName,
  controllerName,
  selfControl = false,
  startedAt,
  locale,
  children,
}: {
  bot?: AvatarIdentity | undefined
  botName: string
  waiting: boolean
  requesterName: string
  controllerName: string | null
  selfControl?: boolean
  startedAt: number
  locale: Locale
  children?: ReactNode
}) => {
  const [now, setNow] = useState(Date.now)
  const [controlStartedAt, setControlStartedAt] = useState(Date.now)

  useEffect(() => {
    if (!controllerName) return

    setControlStartedAt(Date.now())
  }, [controllerName])

  useEffect(() => {
    if (!waiting && !controllerName) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)

    return () => window.clearInterval(timer)
  }, [controllerName, waiting])

  const seconds = Math.max(0, Math.floor((now - (controllerName ? controlStartedAt : startedAt)) / 1_000))
  const status = getBrowserLiveStatus({ waiting, requesterName, controllerName, selfControl, locale })
  const elapsed = controllerName
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : t("{seconds} s ago", { seconds }, locale)

  return (
    <header className="browser-activity-header">
      <BotAvatar
        bot={bot ?? { id: botName, color: "var(--brand)" }}
        size={28}
        mood={waiting || controllerName ? "waiting" : "working"}
      />
      <div className="browser-activity-heading">
        <strong>{t("Browser for {name}", { name: botName }, locale)}</strong>
        <span className="browser-activity-subtitle">
          <span role="status" aria-label={controllerName ? t("Browser privacy", {}, locale) : undefined}>
            {status}
          </span>
          {(waiting || controllerName) && <span aria-hidden="true"> · {elapsed}</span>}
        </span>
      </div>
      <Badge className="browser-activity-live">
        <span className="browser-activity-chrome-live" aria-hidden="true" />
        {t("Live", {}, locale)}
      </Badge>
      {children}
    </header>
  )
}

const getBrowserLiveStatus = ({
  waiting,
  requesterName,
  controllerName,
  selfControl,
  locale,
}: {
  waiting: boolean
  requesterName: string
  controllerName: string | null
  selfControl: boolean
  locale: Locale
}): string => {
  if (controllerName && selfControl) return t("You are using the browser", {}, locale)
  if (controllerName) return t("{person} is using the browser", { person: controllerName }, locale)
  if (waiting) return t("Waiting for {person}", { person: requesterName }, locale)

  return t("The bot is using the browser.", {}, locale)
}
