import type { Bot, BotGroup, ChannelPerson, Thread } from "@touri/contracts"
import { avatarColorFor } from "@touri/contracts/avatar"
import { memo, useEffect, useMemo, useState } from "react"
import { ChannelHeaderChip, ChannelWorkingMarker } from "../features/channelBrowser/ChannelBrowser"
import { type Locale, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import { DeleteGroupDialog } from "./DeleteGroupDialog"
import { PanelIcon } from "./PanelIcon"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import "./groups.css"

const EMPTY_BOTS: Bot[] = []
const EMPTY_WORKING_BOTS: string[] = []
const EMPTY_THREADS: Thread[] = []

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
export const GroupSidebar = memo(
  ({
    groups,
    bots = EMPTY_BOTS,
    threads,
    attentionThreadIds = new Set(),
    channelWorking,
    selectedThreadId,
    onSelect,
    onCreate,
    onSearch,
    onEdit,
    onNewThread,
    onDelete,
    locale = "pt-BR",
  }: {
    groups: BotGroup[]
    bots?: Bot[]
    threads: Thread[]
    channelWorking?: Record<string, string[]> | undefined
    attentionThreadIds?: ReadonlySet<string>
    selectedThreadId: string | null
    onSelect: (id: string) => void
    onCreate: () => void
    onSearch?: (() => void) | undefined
    onEdit: (group: BotGroup) => void
    onNewThread: (group: BotGroup) => void
    onDelete?: ((groupId: string) => Promise<void>) | undefined
    locale?: Locale
  }) => {
    const threadSummaries = useMemo(
      () => getGroupThreadSummaries(threads, attentionThreadIds),
      [threads, attentionThreadIds],
    )
    const membersByGroup = useMemo(
      () =>
        new Map(
          groups.map((group) => [
            group.id,
            group.memberIds.flatMap((id) => {
              const bot = bots.find((candidate) => candidate.id === id)
              return bot ? [bot] : []
            }),
          ]),
        ),
      [groups, bots],
    )

    return (
      <section className="group-sidebar" aria-label={t("Channels", {}, locale)}>
        {onSearch && (
          <button
            type="button"
            className="channel-search-trigger"
            aria-label={t("Search channels and messages", {}, locale)}
            onClick={onSearch}
          >
            <span aria-hidden="true">⌕</span>
            <span>{t("Search channels and messages", {}, locale)}</span>
          </button>
        )}
        <div className="group-sidebar-heading">
          <h2>{t("Channels", {}, locale)}</h2>
          <button
            type="button"
            className="channel-create"
            aria-label={t("New channel", {}, locale)}
            title={t("New channel", {}, locale)}
            onClick={onCreate}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
        {groups.length === 0 && (
          <div className="group-sidebar-empty">
            <strong>{t("No channels yet", {}, locale)}</strong>
            <p>{t("Channels explainer", {}, locale)}</p>
            <button type="button" className="group-empty-create" onClick={onCreate}>
              {t("Create channel", {}, locale)}
            </button>
          </div>
        )}
        {groups.map((group) => {
          const summary = threadSummaries.get(group.id)
          const groupThreads = summary?.threads ?? EMPTY_THREADS
          const isSelected = groupThreads.some((thread) => thread.id === selectedThreadId)
          const selectedUnread = groupThreads.find((thread) => thread.id === selectedThreadId)?.unread ?? 0

          return (
            <GroupSidebarEntry
              key={group.id}
              group={group}
              bots={membersByGroup.get(group.id) ?? EMPTY_BOTS}
              threads={isSelected ? groupThreads : EMPTY_THREADS}
              firstThreadId={groupThreads[0]?.id ?? null}
              unread={summary?.unread ?? 0}
              selectedUnread={selectedUnread}
              needsAttention={summary?.needsAttention ?? false}
              selected={isSelected}
              selectedThreadId={isSelected ? selectedThreadId : null}
              onSelect={onSelect}
              onEdit={onEdit}
              onNewThread={onNewThread}
              onDelete={onDelete}
              workingBots={channelWorking?.[group.id] ?? EMPTY_WORKING_BOTS}
              locale={locale}
            />
          )
        })}
      </section>
    )
  },
)

type GroupThreadSummary = {
  threads: Thread[]
  unread: number
  needsAttention: boolean
}

const getGroupThreadSummaries = (threads: Thread[], attentionThreadIds: ReadonlySet<string>) =>
  threads.reduce((summaries, thread) => {
    if (!thread.groupId || thread.groupThreadId) return summaries

    const summary = summaries.get(thread.groupId) ?? { threads: [], unread: 0, needsAttention: false }
    // A local accumulator keeps the channel index linear in the thread count.
    summary.threads.push(thread)
    summary.unread += thread.unread
    summary.needsAttention ||= attentionThreadIds.has(thread.id)
    summaries.set(thread.groupId, summary)

    return summaries
  }, new Map<string, GroupThreadSummary>())

const GroupSidebarEntry = memo(
  ({
    group,
    bots,
    threads,
    firstThreadId,
    unread,
    selectedUnread,
    needsAttention,
    workingBots,
    selected,
    selectedThreadId,
    onSelect,
    onEdit,
    onNewThread,
    onDelete,
    locale,
  }: {
    group: BotGroup
    bots: Bot[]
    threads: Thread[]
    firstThreadId: string | null
    unread: number
    selectedUnread: number
    needsAttention: boolean
    workingBots: string[]
    selected: boolean
    selectedThreadId: string | null
    onSelect: (id: string) => void
    onEdit: (group: BotGroup) => void
    onNewThread: (group: BotGroup) => void
    onDelete?: ((groupId: string) => Promise<void>) | undefined
    locale: Locale
  }) => {
    const [menuOpen, setMenuOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const navigationKey = selected ? selectedThreadId : null
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigating away dismisses the group's actions
    useEffect(() => setMenuOpen(false), [navigationKey])

    const attentionLabel = t("Channel attention count", { count: 1 }, locale)
    const unreadCount = Math.max(0, unread - selectedUnread)
    const unreadLabel = t("Unread messages", { count: unreadCount }, locale)
    const stateLabels = [...(needsAttention ? [attentionLabel] : []), ...(unreadCount > 0 ? [unreadLabel] : [])]

    return (
      <div className={`group-sidebar-item ${selected ? "selected" : ""}`}>
        <SidebarRow
          selected={selected}
          rowAttention={needsAttention ? "waiting" : undefined}
          className="group-select"
          ariaLabel={[group.name, ...stateLabels].join(", ")}
          leading={
            <>
              <span className="channel-hash">#</span>
              <span className="channel-bot-avatars" aria-hidden="true">
                {bots.slice(0, 2).map((bot) => (
                  <span
                    key={bot.id}
                    className="channel-bot-avatar"
                    style={{ backgroundColor: bot.color ?? avatarColorFor(bot) }}
                  >
                    {bot.name.trim().slice(0, 1).toLocaleUpperCase(locale) || "?"}
                  </span>
                ))}
                {bots.length > 2 && <span className="channel-bot-overflow">+{bots.length - 2}</span>}
              </span>
            </>
          }
          label={
            <>
              <span className="channel-name">{group.name}</span>
              <ChannelWorkingMarker names={workingBots} locale={locale} />
            </>
          }
          trailing={
            needsAttention ? (
              <SidebarDot tone="waiting" label={attentionLabel} />
            ) : unreadCount > 0 ? (
              <SidebarCount count={unreadCount} label={unreadLabel} />
            ) : null
          }
          actions={
            <SidebarActionsMenu
              label={t("Channel actions for {name}", { name: group.name }, locale)}
              open={menuOpen}
              onOpenChange={setMenuOpen}
              actions={[
                { label: t("Edit channel", {}, locale), onSelect: () => onEdit(group) },
                { label: t("New conversation", {}, locale), onSelect: () => onNewThread(group) },
                ...(onDelete
                  ? [{ label: t("Delete channel", {}, locale), onSelect: () => setDeleting(true), destructive: true }]
                  : []),
              ]}
            />
          }
          onClick={() => {
            if (!firstThreadId) return onNewThread(group)

            onSelect(firstThreadId)
          }}
        />
        {deleting && onDelete && (
          <DeleteGroupDialog
            group={group}
            onDelete={onDelete}
            onClose={() => setDeleting(false)}
            locale={locale}
            channelMode
          />
        )}
        {selected && threads.length > 1 && (
          <div className="group-thread-list">
            {threads.map((thread) => (
              <button
                type="button"
                key={thread.id}
                aria-current={thread.id === selectedThreadId ? "page" : undefined}
                onClick={() => onSelect(thread.id)}
              >
                {thread.title}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  },
)

export const GroupRoutingNote = (_props: { group: BotGroup; bots: Bot[]; channelMode?: boolean }) => (
  <p className="group-routing-note">{t("Os bots só respondem quando você os chama com @nome.")}</p>
)

const GroupMembers = ({
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
}) => (
  <ol className="group-context-members" aria-label={t(channelMode ? "Channel members" : "Membros do grupo")}>
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
  const startTitle = channelMode
    ? t("Start a conversation in channel {name}", { name: group.name })
    : t("Comece uma conversa com {name}", { name: group.name })
  const startHint = t("Os bots só respondem quando você os chama com @nome.")

  return (
    <section
      className={`conversation-start${channelMode ? " channel-conversation-start" : ""}`}
      aria-label={startTitle}
    >
      {channelMode ? (
        <span className="channel-start-hash" aria-hidden="true">
          #
        </span>
      ) : (
        <BotAvatar
          bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
          size={36}
        />
      )}
      <h2>{startTitle}</h2>
      <p>{startHint}</p>
      <GroupMembers
        group={group}
        bots={bots}
        people={people}
        currentPersonId={currentPersonId}
        channelMode={channelMode}
      />
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
  const coordinator = bots.find((bot) => bot.id === group.coordinatorBotId)
  const botCount = t(bots.length === 1 ? "1 bot" : "{count} bots", { count: bots.length }, locale)
  const peopleCount = getChannelPeopleCount(people.length, locale)
  const coordinatorLabel = coordinator ? t("{name} coordinates", { name: coordinator.name }, locale) : ""
  const channelSummary = [peopleCount, botCount, coordinatorLabel].filter(Boolean).join(" · ")

  return (
    <header className={`chat-header group-header${channelMode ? " channel-mode" : ""}`} data-tauri-drag-region="deep">
      <div>
        <span className="chat-header-crumb">
          {t(channelMode ? "Channels / {name}" : "Grupos / {name}", { name: group.name }, locale)}
        </span>
        <div className={`group-heading-name ${channelMode ? "channel-heading-name" : ""}`}>
          {channelMode ? (
            <span className="channel-heading-hash" aria-hidden="true">
              #
            </span>
          ) : (
            <BotAvatar
              bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
              size={30}
            />
          )}
          <strong>{group.name}</strong>
          <span className="group-member-count">
            {channelMode ? channelSummary : t("Group member count", { count: bots.length }, locale)}
          </span>
        </div>
      </div>
      <ChannelHeaderChip locale={locale} />
      {!channelMode && (
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
      )}
      <div className="group-header-actions">
        {onTogglePanel && (
          <button
            type="button"
            className="toolbar-icon bot-panel-toggle"
            aria-label={t(channelMode ? "Channel panel" : "Painel do grupo", {}, locale)}
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
          {t(channelMode ? "Edit channel" : "Editar grupo", {}, locale)}
        </button>
      </div>
    </header>
  )
}

export const ChannelPeople = ({
  people,
  currentPersonId,
}: {
  people: ChannelPerson[]
  currentPersonId?: string | null | undefined
}) =>
  people.map((person) => (
    <li key={`person:${person.id}`}>
      <span className="channel-person-avatar" aria-hidden="true">
        {Array.from(person.name.trim())[0]?.toLocaleUpperCase("pt-BR")}
      </span>
      <div>
        <strong>{person.id === currentPersonId ? t("Você") : person.name}</strong>
        <small>{t("Person")}</small>
      </div>
    </li>
  ))

const getChannelPeopleCount = (count: number, locale: Locale): string => {
  if (!count) return ""

  return t(count === 1 ? "1 person" : "{count} people", { count }, locale)
}
