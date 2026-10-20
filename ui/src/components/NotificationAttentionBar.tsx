import type { NotificationRecord } from "@touri/contracts"
import { type TranslationKey, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import "./notification-attention-bar.css"

export const NotificationAttentionBar = ({
  notifications,
  onSelect,
}: {
  notifications: ReadonlyArray<NotificationRecord>
  onSelect: (notification: NotificationRecord) => void
}) => {
  const pending = notifications.filter((item) => item.resolvedAt === null)
  const first = pending[0]
  if (!first) return null

  const bots = pending
    .filter((item, index, items) => items.findIndex((candidate) => candidate.botId === item.botId) === index)
    .slice(0, 3)
  const reason = getReason(first)

  return (
    <button
      type="button"
      className="sidebar-needs-you"
      aria-label={t("Open pending item for {name}", { name: first.botName ?? "touri" })}
      title={t(reason, { name: first.botName ?? "touri" })}
      onClick={() => onSelect(first)}
    >
      <span className="sidebar-needs-you-avatars" aria-hidden="true">
        {bots.map((item) => (
          <BotAvatar
            key={item.botId ?? `notification-${item.id}`}
            bot={{
              id: item.botId ?? "touri",
              color: item.botColor,
              avatarShape: item.avatarShape,
              avatarSeed: item.avatarSeed ?? null,
              name: item.botName ?? "touri",
            }}
            size={26}
            still
          />
        ))}
      </span>
      <span className="sidebar-needs-you-copy">
        <strong>{t("Precisa de você")}</strong>
        <small>{t(reason, { name: first.botName ?? "touri" })}</small>
      </span>
      {pending.length > 1 && <span className="sidebar-needs-you-count">{pending.length}</span>}
      <span className="sidebar-needs-you-arrow" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

const getReason = (item: NotificationRecord): TranslationKey => {
  if (item.kind === "approval") return "{name} wants your approval"
  if (item.kind === "question") return "{name} needs your answer"
  if (item.kind === "takeover") return "{name} needs your help"
  if (item.kind === "turn-failed" || item.kind === "routine-failed" || item.kind === "incident")
    return "{name} has a task to review"

  return "{name} is waiting for you"
}
