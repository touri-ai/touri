import type { AvatarShape, Bot, BotGroup, GroupInput, Message, Run, Thread } from "@touri/contracts"
import { avatarColorFor, avatarShapeFor } from "@touri/contracts/avatar"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import { userFacingError } from "../errors"
import { type Locale, t } from "../i18n"
import { AvatarPicker } from "./AvatarPicker"
import { BotAvatar } from "./BotAvatar"
import { DeleteGroupDialog } from "./DeleteGroupDialog"
import { getGroupProjection, getIdleMemberState } from "./groupProjection"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import "./groups.css"

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
    bots,
    threads,
    attentionThreadIds = new Set(),
    selectedThreadId,
    onSelect,
    onCreate,
    onEdit,
    onNewThread,
    onDelete,
    locale = "pt-BR",
  }: {
    groups: BotGroup[]
    bots: Bot[]
    threads: Thread[]
    attentionThreadIds?: ReadonlySet<string>
    selectedThreadId: string | null
    onSelect: (id: string) => void
    onCreate: () => void
    onEdit: (group: BotGroup) => void
    onNewThread: (group: BotGroup) => void
    onDelete?: ((groupId: string) => Promise<void>) | undefined
    locale?: Locale
  }) => {
    const threadSummaries = useMemo(
      () => getGroupThreadSummaries(threads, attentionThreadIds),
      [threads, attentionThreadIds],
    )

    return (
      <section className="group-sidebar" aria-label={t("Channels", {}, locale)}>
        <div className="group-sidebar-heading">
          <span>
            {t("Channels", {}, locale)} <small>{groups.length}</small>
          </span>
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
          <p className="group-sidebar-empty">
            {t("No channels yet, create one to work with bots and people.", {}, locale)}
          </p>
        )}
        {groups.map((group) => {
          const summary = threadSummaries.get(group.id)

          return (
            <GroupSidebarEntry
              key={group.id}
              group={group}
              bots={bots}
              threads={summary?.threads ?? []}
              unread={summary?.unread ?? 0}
              needsAttention={summary?.needsAttention ?? false}
              selected={summary?.threads.some((thread) => thread.id === selectedThreadId) ?? false}
              selectedThreadId={
                summary?.threads.some((thread) => thread.id === selectedThreadId) ? selectedThreadId : null
              }
              onSelect={onSelect}
              onEdit={onEdit}
              onNewThread={onNewThread}
              onDelete={onDelete}
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
    unread,
    needsAttention,
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
    unread: number
    needsAttention: boolean
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

    return (
      <div className={`group-sidebar-item ${selected ? "selected" : ""}`}>
        <div className="group-sidebar-row">
          <button
            type="button"
            className="group-select"
            aria-label={[
              group.name,
              needsAttention
                ? t("Channel attention count", { count: 1 }, locale)
                : unread > 0
                  ? t("Unread messages", { count: unread }, locale)
                  : null,
            ]
              .filter(Boolean)
              .join(", ")}
            onClick={() => {
              const thread = threads[0]
              if (!thread) return onNewThread(group)

              onSelect(thread.id)
            }}
            aria-current={selected ? "page" : undefined}
          >
            <span className="channel-hash" aria-hidden="true">
              #
            </span>
            <span className="channel-name">{group.name}</span>
            <MemberMascots
              bots={group.memberIds.flatMap((id) => {
                const bot = bots.find((bot) => bot.id === id)
                return bot ? [bot] : []
              })}
              locale={locale}
            />
            {needsAttention ? (
              <span
                className="channel-attention-badge"
                role="img"
                aria-label={t("Channel attention count", { count: 1 }, locale)}
              >
                !
              </span>
            ) : unread > 0 ? (
              <span className="sidebar-unread" role="img" aria-label={t("Unread messages", { count: unread }, locale)}>
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </button>
          <SidebarActionsMenu
            label={t("Channel actions for {name}", { name: group.name }, locale)}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            actions={[
              { label: t("Edit channel", {}, locale), onSelect: () => onEdit(group) },
              ...(onDelete
                ? [{ label: t("Delete channel", {}, locale), onSelect: () => setDeleting(true), destructive: true }]
                : []),
            ]}
          />
        </div>
        {deleting && onDelete && (
          <DeleteGroupDialog
            group={group}
            onDelete={onDelete}
            onClose={() => setDeleting(false)}
            locale={locale}
            channelMode
          />
        )}
        {selected && (
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
            <button type="button" onClick={() => onNewThread(group)}>
              + {t("New conversation", {}, locale)}
            </button>
          </div>
        )}
      </div>
    )
  },
)

export const GroupRoutingNote = ({
  group,
  bots,
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  channelMode?: boolean
}) => {
  const coordinator = bots.find((bot) => bot.id === group.coordinatorBotId)
  return (
    <p className="group-routing-note">
      {channelMode
        ? coordinator
          ? t("Channel coordinator routing note", { name: coordinator.name })
          : t("Channel member routing note")
        : coordinator
          ? t("{name} coordena as respostas e pode delegar aos membros. Use @nome para falar com um membro.", {
              name: coordinator.name,
            })
          : t("Sem menções, todos os membros respondem na ordem da lista. Use @nome para escolher quem responde.")}
    </p>
  )
}

const GroupMembers = ({
  group,
  bots,
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  channelMode?: boolean
}) => (
  <ol className="group-context-members" aria-label={t(channelMode ? "Channel members" : "Membros do grupo")}>
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
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  channelMode?: boolean
}) => (
  <section
    className="conversation-start"
    aria-label={t(channelMode ? "Start a conversation with {name}" : "Comece uma conversa com {name}", {
      name: group.name,
    })}
  >
    <BotAvatar
      bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
      size={36}
    />
    <h2>
      {t(channelMode ? "Start a conversation with {name}" : "Comece uma conversa com {name}", { name: group.name })}
    </h2>
    <p>
      {t(channelMode ? "Tell the channel what to do to get started." : "Conte o que o grupo deve fazer para começar.")}
    </p>
    <GroupMembers group={group} bots={bots} channelMode={channelMode} />
    <GroupRoutingNote group={group} bots={bots} channelMode={channelMode} />
  </section>
)

export const GroupPanel = ({
  group,
  bots,
  threadId,
  messages = [],
  runs = [],
  onClose,
  onEdit,
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  threadId?: string | undefined
  messages?: Message[]
  runs?: Run[]
  onClose: () => void
  onEdit: () => void
  channelMode?: boolean
}) => {
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
  onEdit,
  panelOpen,
  onTogglePanel,
  locale = "pt-BR",
  channelMode = false,
}: {
  group: BotGroup
  bots: Bot[]
  onEdit: () => void
  panelOpen?: boolean
  onTogglePanel?: (() => void) | undefined
  locale?: Locale
  channelMode?: boolean
}) => (
  <header className="chat-header group-header" data-tauri-drag-region="deep">
    <div>
      <span className="chat-header-crumb">
        {t(channelMode ? "Channels / {name}" : "Grupos / {name}", { name: group.name }, locale)}
      </span>
      <div className="group-heading-name">
        <BotAvatar
          bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
          size={30}
        />
        <strong>{group.name}</strong>
        <span className="group-member-count">
          {t(channelMode ? "Channel member count" : "Group member count", { count: bots.length }, locale)}
        </span>
      </div>
    </div>
    <div className="group-header-members">
      <MemberMascots bots={bots} locale={locale} />
      <span>
        {bots
          .map((b) => `${b.name}${b.id === group.coordinatorBotId ? t("Group coordinator suffix", {}, locale) : ""}`)
          .join(", ")}
      </span>
    </div>
    {onTogglePanel && (
      <button
        type="button"
        className="toolbar-icon bot-panel-toggle"
        aria-label={t(channelMode ? "Channel panel" : "Painel do grupo", {}, locale)}
        aria-expanded={panelOpen}
        aria-controls="bot-panel"
        onClick={onTogglePanel}
      >
        ◧
      </button>
    )}
    <button type="button" className="button button-quiet" onClick={onEdit}>
      {t(channelMode ? "Edit channel" : "Editar grupo", {}, locale)}
    </button>
  </header>
)

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
  const [shape, setShape] = useState<AvatarShape>(() => group?.avatarShape ?? avatarShapeFor(avatarSeed))
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
                avatarShape: shape,
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
            label={t(channelMode ? "Channel mascot" : "Group mascot")}
            description={t(channelMode ? "Customize your channel" : "Customize your group")}
            name={name}
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
          <p className="group-routing-note">
            {coordinatorBotId
              ? t(
                  channelMode
                    ? "The channel coordinator receives the request and may delegate to members."
                    : "The group coordinator receives the request and may delegate to members.",
                )
              : t(
                  channelMode
                    ? "Mention @name to choose who replies. Without a mention, all members reply in order."
                    : "Group member routing note",
                )}
          </p>
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
