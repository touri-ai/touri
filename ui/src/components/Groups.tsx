import type { Bot, BotGroup, ChannelPerson, Message, Run, Thread } from "@touri/contracts"
import { avatarColorFor } from "@touri/contracts/avatar"
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { latestPreview } from "../botPreview"
import { getChannelSidebarThreads, getChannelThreads, getChannelThreadTitle } from "../channelThreads"
import { ChannelHeaderChip, ChannelWorkingMarker } from "../features/channelBrowser/ChannelBrowser"
import { type Locale, t } from "../i18n"
import { getLastActivityAt, getSidebarRowTime } from "../sidebarAttention"
import { BotAvatar } from "./BotAvatar"
import { ConversationLoading } from "./ConversationLoading"
import { PanelIcon } from "./PanelIcon"
import { PersonAvatar } from "./PersonAvatar"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import "./conversation-start.css"
import "./groups.css"

const DeleteGroupDialog = lazy(() =>
  import("./DeleteGroupDialog").then((module) => ({ default: module.DeleteGroupDialog })),
)

const EMPTY_WORKING_BOTS: string[] = []
const EMPTY_THREADS: Thread[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_RUNS: Run[] = []

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
    loading = false,
    groups,
    threads,
    attentionThreadIds = new Set(),
    channelWorking,
    selectedThreadId,
    onSelect,
    onCreate,
    onInvite,
    onSearch,
    onEdit,
    onNewThread,
    onDelete,
    messages = EMPTY_MESSAGES,
    runs = EMPTY_RUNS,
    locale = "pt-BR",
  }: {
    loading?: boolean | undefined
    groups: BotGroup[]
    threads: Thread[]
    messages?: Message[]
    runs?: Run[]
    onInvite?: (() => void) | undefined
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
    const previews = useMemo(() => getGroupPreviews(threadSummaries, messages, runs), [threadSummaries, messages, runs])
    const [pendingGroupId, setPendingGroupId] = useState<string | null>(null)
    const selectThread = useCallback(
      (id: string) => {
        setPendingGroupId(null)
        onSelect(id)
      },
      [onSelect],
    )
    useEffect(() => {
      if (!pendingGroupId) return
      const thread = getChannelThreads(threads, pendingGroupId)[0]
      if (thread) selectThread(thread.id)
    }, [pendingGroupId, threads, selectThread])

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
          {onInvite && (
            <button
              type="button"
              className="channel-invite-link"
              aria-label={t("Convidar pessoa", {}, locale)}
              title={t("Convidar pessoa", {}, locale)}
              onClick={onInvite}
            >
              <span aria-hidden="true">+</span> {t("Invite short", {}, locale)}
            </button>
          )}
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
        {loading && groups.length === 0 && <ConversationLoading />}
        {!loading && groups.length === 0 && (
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
              loading={loading}
              onPendingSelect={setPendingGroupId}
              key={group.id}
              group={group}
              threads={isSelected ? groupThreads : EMPTY_THREADS}
              firstThreadId={getChannelThreads(groupThreads, group.id)[0]?.id ?? null}
              preview={previews.get(group.id) ?? ""}
              time={getSidebarRowTime(getLastActivityAt(groupThreads))}
              unread={summary?.unread ?? 0}
              selectedUnread={selectedUnread}
              needsAttention={summary?.needsAttention ?? false}
              selected={isSelected}
              selectedThreadId={isSelected ? selectedThreadId : null}
              onSelect={selectThread}
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

const getGroupPreviews = (summaries: ReadonlyMap<string, GroupThreadSummary>, messages: Message[], runs: Run[]) => {
  const groupsByThread = new Map(
    Array.from(summaries).flatMap(([groupId, summary]) => summary.threads.map((thread) => [thread.id, groupId])),
  )
  const messagesByGroup = messages.reduce((index, message) => {
    const groupId = groupsByThread.get(message.threadId)
    if (!groupId) return index

    // A local index avoids copying and scanning workspace history for every channel on each update.
    const groupMessages = index.get(groupId) ?? []
    groupMessages.push(message)
    index.set(groupId, groupMessages)

    return index
  }, new Map<string, Message[]>())

  return new Map(
    Array.from(summaries).map(([groupId, summary]) => [
      groupId,
      latestPreview({
        threadIds: summary.threads.map((thread) => thread.id),
        messages: messagesByGroup.get(groupId) ?? EMPTY_MESSAGES,
        runs,
      }),
    ]),
  )
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
    loading,
    onPendingSelect,
    group,
    threads,
    firstThreadId,
    preview,
    time,
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
    loading: boolean
    onPendingSelect: (groupId: string) => void
    group: BotGroup
    threads: Thread[]
    firstThreadId: string | null
    preview: string
    time: string
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
    const conversations = selected ? getChannelSidebarThreads(threads, group, locale) : []

    return (
      <div className={`group-sidebar-item ${selected ? "selected" : ""}`}>
        <SidebarRow
          selected={selected}
          rowAttention={needsAttention ? "waiting" : undefined}
          className="group-select"
          ariaLabel={[group.name, ...stateLabels].join(", ")}
          leading={<span className="channel-hash">#</span>}
          label={
            <span className="bot-row-text">
              <span className="bot-row-top">
                <span className="channel-name">{group.name}</span>
                <ChannelWorkingMarker names={workingBots} locale={locale} />
                {time && <small className="bot-row-time">{time}</small>}
              </span>
              {preview && (
                <small className="bot-preview" title={preview}>
                  {preview}
                </small>
              )}
            </span>
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
            if (!firstThreadId && loading) return onPendingSelect(group.id)
            if (!firstThreadId) return onNewThread(group)

            onSelect(firstThreadId)
          }}
        />
        {deleting && onDelete && (
          <Suspense fallback={null}>
            <DeleteGroupDialog
              group={group}
              onDelete={onDelete}
              onClose={() => setDeleting(false)}
              locale={locale}
              channelMode
            />
          </Suspense>
        )}
        {selected && conversations.length > 0 && (
          <div className="group-thread-list">
            {conversations.map((thread) => (
              <button
                type="button"
                key={thread.id}
                aria-current={thread.id === selectedThreadId ? "page" : undefined}
                onClick={() => onSelect(thread.id)}
              >
                {getChannelThreadTitle(thread, locale)}
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
