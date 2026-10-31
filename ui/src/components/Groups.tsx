import type { Bot, BotGroup, ChannelPerson } from "@touri/contracts"
import { avatarColorFor } from "@touri/contracts/avatar"
import { useState } from "react"
import { ChannelHeaderChip } from "../features/channelBrowser/ChannelBrowser"
import { type Locale, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import { PanelIcon } from "./PanelIcon"
import { PersonAvatar } from "./PersonAvatar"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import "./conversation-start.css"
import "./groups.css"

export { GroupSidebar } from "./GroupSidebar"

export const MemberMascots = ({ bots, locale = "pt-BR" }: { bots: Bot[]; locale?: Locale }) => (
  <span
    role="img"
    className="group-mascots"
    aria-label={t(
      bots.length ? "Group members label" : "Group member count",
      {
        count: bots.length,
        names: bots.map((b) => b.name).join(", "),
      },
      locale,
    )}
  >
    {bots.slice(0, 2).map((bot) => (
      <span
        key={bot.id}
        className="group-member-avatar"
        style={{ backgroundColor: bot.color ?? avatarColorFor(bot) }}
        aria-hidden="true"
      >
        {bot.name.trim().slice(0, 1).toLocaleUpperCase(locale) || "?"}
      </span>
    ))}
    {bots.length > 2 && <span className="group-member-avatar group-member-avatar-more">+{bots.length - 2}</span>}
  </span>
)
export const GroupRoutingNote = (_props: { group: BotGroup; bots: Bot[]; channelMode?: boolean }) => (
  <p className="group-routing-note">{t("Os bots só respondem quando você os chama com @nome.")}</p>
)

const GroupMembers = ({
  group,
  bots,
  people = [],
  currentPersonId,
}: {
  group: BotGroup
  bots: Bot[]
  people?: ChannelPerson[]
  currentPersonId?: string | null | undefined
}) => (
  <ol className="group-context-members" aria-label={t("Membros do grupo")}>
    <ChannelPeople people={people} currentPersonId={currentPersonId} />
    {bots.map((bot) => (
      <li key={bot.id}>
        <BotAvatar bot={bot} size={28} />
        <div>
          <strong>{bot.name}</strong>
          {bot.id === group.coordinatorBotId && <small>{t("Coordenador")}</small>}
          {bot.roleLine && <small>{bot.roleLine}</small>}
        </div>
      </li>
    ))}
  </ol>
)

export const GroupConversationStart = ({
  group,
  bots,
  people = [],
  currentPersonId,
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  people?: ChannelPerson[]
  currentPersonId?: string | null | undefined
  channelMode?: boolean
}) => {
  if (channelMode) return <ChannelConversationStart group={group} bots={bots} people={people} />

  const startTitle = t("Comece uma conversa com {name}", { name: group.name })

  return (
    <section className="conversation-start" aria-label={startTitle}>
      <BotAvatar
        bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
        size={36}
      />
      <h2>{startTitle}</h2>
      <p>{t("Os bots só respondem quando você os chama com @nome.")}</p>
      <GroupMembers group={group} bots={bots} people={people} currentPersonId={currentPersonId} />
    </section>
  )
}

/** An empty channel needs one line, the faces of who can answer and how to call them. */
const ChannelConversationStart = ({
  group,
  bots,
  people,
}: {
  group: BotGroup
  bots: Bot[]
  people: ChannelPerson[]
}) => {
  const startTitle = t("Start a conversation in channel {name}", { name: group.name })

  return (
    <section className="conversation-start channel-conversation-start" aria-label={startTitle}>
      <h2>{startTitle}</h2>
      <ul className="channel-start-members" aria-label={t("Channel members")}>
        {people.map((person) => (
          <li key={`person:${person.id}`} title={person.name}>
            <PersonAvatar person={person} />
            <span className="visually-hidden">{person.name}</span>
          </li>
        ))}
        {bots.map((bot) => (
          <li key={bot.id} title={bot.name}>
            <BotAvatar bot={bot} size={28} />
            <span className="visually-hidden">{bot.name}</span>
          </li>
        ))}
      </ul>
      <p className="channel-start-hint">{t("Os bots só respondem quando você os chama com @nome.")}</p>
    </section>
  )
}

export const GroupHeader = ({
  group,
  bots,
  people = [],
  onEdit,
  onInvite,
  panelOpen,
  onTogglePanel,
  locale = "pt-BR",
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  people?: ChannelPerson[]
  onEdit: () => void
  onInvite?: (() => void) | undefined
  panelOpen?: boolean
  onTogglePanel?: (() => void) | undefined
  locale?: Locale
  channelMode?: boolean
}) => {
  if (channelMode)
    return (
      <ChannelHeader
        group={group}
        bots={bots}
        people={people}
        onEdit={onEdit}
        onInvite={onInvite}
        panelOpen={panelOpen}
        onTogglePanel={onTogglePanel}
        locale={locale}
      />
    )

  return (
    <header className="chat-header group-header" data-tauri-drag-region="deep">
      <div>
        <span className="chat-header-crumb">{t("Grupos / {name}", { name: group.name }, locale)}</span>
        <div className="group-heading-name">
          <BotAvatar
            bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
            size={30}
          />
          <strong>{group.name}</strong>
          <span className="group-member-count">{t("Group member count", { count: bots.length }, locale)}</span>
        </div>
      </div>
      <ChannelHeaderChip locale={locale} />
      <div className="group-header-members">
        <MemberMascots bots={bots} locale={locale} />
        <span>
          {bots
            .map(
              (bot) =>
                `${bot.name}${bot.id === group.coordinatorBotId ? t("Group coordinator suffix", {}, locale) : ""}`,
            )
            .join(", ")}
        </span>
      </div>
      <div className="group-header-actions">
        {onTogglePanel && (
          <button
            type="button"
            className="toolbar-icon bot-panel-toggle"
            aria-label={t("Painel do grupo", {}, locale)}
            aria-expanded={panelOpen}
            aria-controls="bot-panel"
            onClick={onTogglePanel}
          >
            <PanelIcon name="panel" />
          </button>
        )}
        {onInvite && (
          <button
            type="button"
            className="toolbar-icon channel-invite"
            aria-label={t("Convidar pessoa", {}, locale)}
            title={t("Convidar pessoa", {}, locale)}
            onClick={onInvite}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
        <button type="button" className="button button-quiet" onClick={onEdit}>
          {t("Editar grupo", {}, locale)}
        </button>
      </div>
    </header>
  )
}

const MAX_HEADER_AVATARS = 3

/** A channel header says only where you are: "# name", who is in it, and one menu for the rest. */
const ChannelHeader = ({
  group,
  bots,
  people,
  onEdit,
  onInvite,
  panelOpen,
  onTogglePanel,
  locale,
}: {
  group: BotGroup
  bots: Bot[]
  people: ChannelPerson[]
  onEdit: () => void
  onInvite?: (() => void) | undefined
  panelOpen?: boolean | undefined
  onTogglePanel?: (() => void) | undefined
  locale: Locale
}) => {
  const [menuOpen, setMenuOpen] = useState(false)
  const botCount = t(bots.length === 1 ? "1 bot" : "{count} bots", { count: bots.length }, locale)
  const summary = [getChannelPeopleCount(people.length, locale), botCount].filter(Boolean).join(" · ")
  const memberCount = people.length + bots.length
  const avatars = (
    <>
      <span className="channel-member-avatars" aria-hidden="true">
        {people.slice(0, MAX_HEADER_AVATARS).map((person) => (
          <PersonAvatar key={`person:${person.id}`} person={person} size={20} />
        ))}
        {bots.slice(0, Math.max(0, MAX_HEADER_AVATARS - people.length)).map((bot) => (
          <BotAvatar key={bot.id} bot={bot} size={20} />
        ))}
      </span>
      <span aria-hidden="true">{memberCount}</span>
    </>
  )
  const membersLabel = t("Channel members summary", { summary }, locale)

  return (
    <header className="chat-header group-header channel-mode" data-tauri-drag-region="deep">
      <div className="group-heading-name channel-heading-name">
        <span className="channel-heading-hash" aria-hidden="true">
          #
        </span>
        <strong>{group.name}</strong>
      </div>
      <ChannelHeaderChip locale={locale} />
      <div className="group-header-actions">
        {onTogglePanel ? (
          <button
            type="button"
            className="channel-members-button bot-panel-toggle"
            aria-label={membersLabel}
            title={summary}
            aria-expanded={panelOpen}
            aria-controls="bot-panel"
            onClick={onTogglePanel}
          >
            {avatars}
          </button>
        ) : (
          <span className="channel-members-button" role="img" aria-label={membersLabel}>
            {avatars}
          </span>
        )}
        <SidebarActionsMenu
          label={t("Channel actions for {name}", { name: group.name }, locale)}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          triggerClassName="toolbar-icon channel-header-menu"
          actions={[
            { label: t("Edit channel", {}, locale), onSelect: onEdit },
            ...(onInvite ? [{ label: t("Convidar pessoa", {}, locale), onSelect: onInvite }] : []),
          ]}
        />
      </div>
    </header>
  )
}

export const ChannelPeople = ({ people }: { people: ChannelPerson[]; currentPersonId?: string | null | undefined }) =>
  people.map((person) => (
    <li key={`person:${person.id}`}>
      <PersonAvatar person={person} />
      <div>
        <strong>{person.handle ?? person.name}</strong>
      </div>
    </li>
  ))

const getChannelPeopleCount = (count: number, locale: Locale): string => {
  if (!count) return ""

  return t(count === 1 ? "1 person" : "{count} people", { count }, locale)
}
