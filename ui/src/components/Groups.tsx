import type { AvatarShape, Bot, BotGroup, ChannelPerson, GroupInput, Message, Run, Thread } from "@touri/contracts"
import { avatarColorFor, avatarProfileFor } from "@touri/contracts/avatar"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { latestPreview } from "../botPreview"
import { userFacingError } from "../errors"
import { ChannelHeaderChip, ChannelWorkingMarker } from "../features/channelBrowser/ChannelBrowser"
import { useChannelPeople } from "../features/channelBrowser/useChannelPeople"
import { type Locale, t } from "../i18n"
import { getLastActivityAt, getSidebarRowTime } from "../sidebarAttention"
import { AvatarPicker } from "./AvatarPicker"
import { BotAvatar } from "./BotAvatar"
import { DeleteGroupDialog } from "./DeleteGroupDialog"
import { getGroupProjection, getIdleMemberState } from "./groupProjection"
import { PanelIcon } from "./PanelIcon"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import "./groups.css"

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
    const previews = useMemo(
      () =>
        new Map(
          [...threadSummaries].map(([groupId, summary]) => [
            groupId,
            latestPreview({ threadIds: summary.threads.map((thread) => thread.id), messages, runs }),
          ]),
        ),
      [threadSummaries, messages, runs],
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
              threads={isSelected ? groupThreads : EMPTY_THREADS}
              firstThreadId={groupThreads[0]?.id ?? null}
              preview={previews.get(group.id) ?? ""}
              time={getSidebarRowTime(getLastActivityAt(groupThreads))}
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
            <span className="channel-person-avatar" aria-hidden="true">
              {Array.from(person.name.trim())[0]?.toLocaleUpperCase("pt-BR")}
            </span>
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

export const GroupPanel = ({
  group,
  api,
  currentPersonId,
  bots,
  threadId,
  messages = [],
  runs = [],
  onClose,
  onEdit,
  channelMode = false,
}: {
  group: BotGroup
  api?: UiApi | null | undefined
  currentPersonId?: string | null | undefined
  bots: Bot[]
  threadId?: string | undefined
  messages?: Message[]
  runs?: Run[]
  onClose: () => void
  onEdit: () => void
  channelMode?: boolean
}) => {
  const people = useChannelPeople(api, channelMode ? group.id : null)
  const { board, members, removed } = useMemo(
    () => getGroupProjection(threadId, messages, runs),
    [threadId, messages, runs],
  )

  return (
    <aside
      className="bot-panel group-panel"
      id="bot-panel"
      aria-label={t(channelMode ? "Channel panel for {name}" : "Painel do grupo {name}", { name: group.name })}
    >
      <div className="bot-panel-top">
        <span>{t(channelMode ? "Your channel" : "Seu grupo")}</span>
        <button
          type="button"
          className="toolbar-icon"
          aria-label={t(channelMode ? "Close channel panel" : "Fechar painel do grupo")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <header className="bot-panel-identity">
        <BotAvatar
          bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
          size={72}
        />
        <h2>{group.name}</h2>
      </header>
      <div className="bot-panel-body">
        <h3>{t(channelMode ? "Channel members" : "Membros do grupo")}</h3>
        <ol
          className="group-context-members group-status-members"
          aria-label={t(channelMode ? "Channel members" : "Membros do grupo")}
        >
          <ChannelPeople people={people} currentPersonId={currentPersonId} />
          {bots.map((bot) => {
            const member = members.get(bot.id) ?? getIdleMemberState()
            return (
              <li key={bot.id}>
                <BotAvatar bot={bot} size={28} />
                <div>
                  <strong>{bot.name}</strong>
                  <small>{t(bot.id === group.coordinatorBotId ? "Coordenador" : "Membro")}</small>
                  {bot.roleLine && <small>{bot.roleLine}</small>}
                  <span className={`group-member-state group-member-state-${member.state}`}>{t(member.label)}</span>
                  <p className="group-member-result">{member.result || t("Sem resultado confirmado.")}</p>
                </div>
              </li>
            )
          })}
        </ol>
        <section className="group-board" aria-label={t("Resultados do turno")}>
          <h3>{t("Resultados do turno")}</h3>
          <p className="muted-copy">{t("Somente respostas finais confirmadas. Este quadro é apenas para leitura.")}</p>
          {board.map((result) => (
            <article key={result.id}>
              <strong>{result.sender?.name}</strong>
              <p>{result.text}</p>
            </article>
          ))}
          {removed.map((message) => (
            <article key={message.id}>
              <strong>{message.sender?.name}</strong>
              <p>{t(channelMode ? "The member was removed from the channel." : "O membro foi removido do grupo.")}</p>
            </article>
          ))}
          {board.length === 0 && removed.length === 0 && (
            <p className="muted-copy">{t("Sem resultados confirmados neste turno.")}</p>
          )}
        </section>
        <GroupRoutingNote group={group} bots={bots} channelMode={channelMode} />
        <p className="muted-copy">
          {t(
            channelMode
              ? "Each bot keeps its own computer and permissions."
              : "Cada bot mantém seu computador e suas permissões.",
          )}
        </p>
        <button type="button" className="button button-quiet" onClick={onEdit}>
          {t(channelMode ? "Edit channel" : "Editar membros")}
        </button>
      </div>
    </aside>
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
          <span key={`person:${person.id}`} className="channel-person-avatar">
            {Array.from(person.name.trim())[0]?.toLocaleUpperCase(locale)}
          </span>
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
            className="channel-members-button"
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

export const GroupModal = ({
  group,
  initial,
  bots,
  onClose,
  onSave,
  channelMode = false,
}: {
  group: BotGroup | null
  initial?: Pick<GroupInput, "name" | "memberIds"> | null
  bots: Bot[]
  onClose: () => void
  onSave: (input: GroupInput) => Promise<void>
  channelMode?: boolean
}) => {
  const [name, setName] = useState(group?.name ?? initial?.name ?? "")
  const [memberIds, setMembers] = useState(group?.memberIds ?? initial?.memberIds ?? [])
  const [coordinatorBotId, setCoordinator] = useState<string | null>(group?.coordinatorBotId ?? null)
  // A new group has no server seed yet; a fresh one per dialog gives each group its own look.
  const [avatarSeed] = useState(() => group?.avatarSeed ?? crypto.randomUUID())
  const [color, setColor] = useState<string | null>(group?.color ?? null)
  // The stored shape is sent back untouched (even an older silhouette id) until the user picks a look.
  const [shape, setShape] = useState<AvatarShape>(() => group?.avatarShape ?? getNewGroupAvatarShape(avatarSeed))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div className="modal-backdrop group-modal-backdrop">
      <div
        className="modal-card group-modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-modal-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose()
          if (event.key === "Tab") {
            const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select")
            const first = controls?.[0]
            const last = controls?.[controls.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <form
          onKeyDown={(event) => {
            // A suggested group needs an explicit save after its prefilled fields are reviewed.
            if (initial && event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) event.preventDefault()
          }}
          onSubmit={async (event) => {
            event.preventDefault()
            setSaving(true)
            setError(null)
            try {
              await onSave({
                name,
                color: color ?? avatarColorFor({ id: avatarSeed, color: null }),
                avatarShape: group ? shape : getNewGroupAvatarShape(avatarSeed, shape),
                memberIds,
                coordinatorBotId,
              })
              onClose()
            } catch (e) {
              setError(userFacingError(e))
            } finally {
              setSaving(false)
            }
          }}
        >
          <div className="group-modal-heading">
            <div>
              <p className="eyebrow">{t("Bots together")}</p>
              <h2 id="group-modal-title">
                {channelMode ? t(group ? "Edit channel" : "Create channel") : t(group ? "Editar grupo" : "Criar grupo")}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label={t(channelMode ? "Close channel" : "Close group")}
            >
              ×
            </button>
          </div>
          <p className="muted-copy">
            {t(
              channelMode
                ? "A shared channel. Each bot keeps its own computer and permissions."
                : "A shared group conversation. Each bot keeps its own computer and permissions.",
            )}
          </p>
          <label className="group-field">
            {t(channelMode ? "Channel name" : "Group name")}
            <input
              aria-label={t(channelMode ? "Channel name" : "Group name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder={t("Example: Product")}
              disabled={saving}
            />
          </label>
          <AvatarPicker
            label={t(channelMode ? "Channel mascot" : "avatar.group")}
            bot={{ id: group?.id ?? avatarSeed, avatarShape: shape, color, avatarSeed }}
            onChange={(v) => {
              if (v.avatarShape) setShape(v.avatarShape)
              if (v.color !== undefined) setColor(v.color)
            }}
          />
          <fieldset disabled={saving}>
            <legend>{t(channelMode ? "Channel members · response order" : "Group members · response order")}</legend>
            <div className="group-member-picker">
              {bots
                .filter((b) => !b.archivedAt)
                .map((bot) => (
                  <label key={bot.id}>
                    <input
                      type="checkbox"
                      aria-label={bot.name}
                      checked={memberIds.includes(bot.id)}
                      onChange={(e) => {
                        setMembers((ids) => (e.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))
                        if (!e.target.checked && coordinatorBotId === bot.id) setCoordinator(null)
                      }}
                    />
                    <BotAvatar bot={bot} size={28} />
                    <span>{bot.name}</span>
                    {memberIds.includes(bot.id) && <small>{memberIds.indexOf(bot.id) + 1}</small>}
                  </label>
                ))}
            </div>
          </fieldset>
          <label className="group-field">
            {t(channelMode ? "Channel coordinator" : "Group coordinator")}{" "}
            <span className="muted-copy">{t("optional")}</span>
            <select
              aria-label={t(channelMode ? "Channel coordinator" : "Group coordinator")}
              value={coordinatorBotId ?? ""}
              disabled={saving}
              onChange={(e) => setCoordinator(e.target.value || null)}
            >
              <option value="">{t(channelMode ? "No channel coordinator" : "Sem coordenador")}</option>
              {memberIds.map((id) => (
                <option key={id} value={id}>
                  {bots.find((b) => b.id === id)?.name}
                </option>
              ))}
            </select>
          </label>
          <p className="group-routing-note">{t("Os bots só respondem quando você os chama com @nome.")}</p>
          {error && <p role="alert">{error}</p>}
          <div className="group-modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>
              {t("Cancelar")}
            </button>
            <button
              type="submit"
              className="button button-brand"
              disabled={saving || !name.trim() || !memberIds.length}
            >
              {saving
                ? t("Saving…")
                : channelMode
                  ? t(group ? "Save channel" : "Create channel")
                  : t(group ? "Salvar grupo" : "Criar grupo")}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// The server assigns a permanent seed on creation; keep the head and look the user previewed, including after reset.
const getNewGroupAvatarShape = (avatarSeed: string, avatarShape?: AvatarShape): AvatarShape => {
  const profile = avatarProfileFor({ id: avatarSeed, color: null, avatarShape: avatarShape ?? null })

  return `${profile.headShape}:${profile.shape}`
}

const ChannelPeople = ({
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
