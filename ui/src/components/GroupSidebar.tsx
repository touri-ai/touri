import type { BotGroup, ChannelReadState, Message, Run, Thread } from "@touri/contracts"
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { latestPreview } from "../botPreview"
import { getChannelSidebarThreads, getChannelThreads, getChannelThreadTitle } from "../channelThreads"
import { ChannelWorkingMarker } from "../features/channelBrowser/ChannelBrowser"
import { type Locale, t } from "../i18n"
import { getLastActivityAt, getSidebarRowTime } from "../sidebarAttention"
import { ConversationLoading } from "./ConversationLoading"
import { DeleteThreadDialog } from "./DeleteThreadDialog"
import { SidebarActionsMenu } from "./SidebarActionsMenu"
import { SidebarCount, SidebarDot, SidebarRow } from "./SidebarRow"
import "./groups.css"

const DeleteGroupDialog = lazy(() =>
  import("./DeleteGroupDialog").then((module) => ({ default: module.DeleteGroupDialog })),
)

const EMPTY_WORKING_BOTS: string[] = []
const EMPTY_CHANNEL_READS: ReadonlyMap<string, ChannelReadState> = new Map()
const EMPTY_THREADS: Thread[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_RUNS: Run[] = []

export const GroupSidebar = memo(
  ({
    loading = false,
    groups,
    threads,
    attentionThreadIds = new Set(),
    channelWorking,
    channelReads = EMPTY_CHANNEL_READS,
    selectedThreadId,
    onSelect,
    onPrefetch,
    onCreate,
    onSearch,
    onEdit,
    onNewThread,
    onDelete,
    onDeleteThread,
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
    /** This person's unread bot replies per channel conversation. */
    channelReads?: ReadonlyMap<string, ChannelReadState> | undefined
    selectedThreadId: string | null
    onSelect: (id: string) => void
    onPrefetch?: ((id: string) => void) | undefined
    onCreate: () => void
    onSearch?: (() => void) | undefined
    onEdit: (group: BotGroup) => void
    onNewThread: (group: BotGroup) => void
    onDeleteThread?: ((threadId: string, botId: string) => Promise<void>) | undefined
    onDelete?: ((groupId: string) => Promise<void>) | undefined
    locale?: Locale
  }) => {
    const threadSummaries = useMemo(
      () => getGroupThreadSummaries(threads, attentionThreadIds),
      [threads, attentionThreadIds],
    )
    const previews = useMemo(() => getGroupPreviews(threadSummaries, messages, runs), [threadSummaries, messages, runs])
    const [pendingGroup, setPendingGroup] = useState<{ id: string; previousThreadId: string | null } | null>(null)
    const selectPendingGroup = useCallback(
      (id: string) => setPendingGroup({ id, previousThreadId: selectedThreadId }),
      [selectedThreadId],
    )
    const selectThread = useCallback(
      (id: string) => {
        setPendingGroup(null)
        onSelect(id)
      },
      [onSelect],
    )
    useEffect(() => {
      if (!pendingGroup) return
      // Initial index hydration can choose a default without superseding the person's channel click.
      const hasNewSelection =
        pendingGroup.previousThreadId !== null &&
        pendingGroup.previousThreadId !== selectedThreadId &&
        threads.some((thread) => thread.id === pendingGroup.previousThreadId)
      if (hasNewSelection) return setPendingGroup(null)
      const thread = getChannelThreads(threads, pendingGroup.id)[0]
      if (thread) selectThread(thread.id)
    }, [pendingGroup, selectedThreadId, threads, selectThread])

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
          // The conversation on screen is being read, so its replies never count.
          const replies = getChannelReplies(groupThreads, channelReads, selectedThreadId)

          return (
            <GroupSidebarEntry
              loading={loading}
              onPendingSelect={selectPendingGroup}
              key={group.id}
              group={group}
              threads={isSelected ? groupThreads : EMPTY_THREADS}
              firstThreadId={getChannelThreads(groupThreads, group.id)[0]?.id ?? null}
              preview={previews.get(group.id) ?? ""}
              time={getSidebarRowTime(getLastActivityAt(groupThreads))}
              unread={(summary?.unread ?? 0) + replies.unread}
              selectedUnread={selectedUnread}
              mentions={replies.mentions}
              needsAttention={summary?.needsAttention ?? false}
              selected={isSelected}
              selectedThreadId={isSelected ? selectedThreadId : null}
              onSelect={selectThread}
              onPrefetch={onPrefetch}
              onEdit={onEdit}
              onNewThread={onNewThread}
              onDelete={onDelete}
              onDeleteThread={onDeleteThread}
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

const getChannelReplies = (
  threads: ReadonlyArray<Thread>,
  reads: ReadonlyMap<string, ChannelReadState>,
  selectedThreadId: string | null,
) =>
  threads.reduce(
    (total, thread) => {
      const read = thread.id === selectedThreadId ? undefined : reads.get(thread.id)
      return { unread: total.unread + (read?.unread ?? 0), mentions: total.mentions + (read?.mentions ?? 0) }
    },
    { unread: 0, mentions: 0 },
  )

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
    time,
    unread,
    selectedUnread,
    mentions,
    needsAttention,
    workingBots,
    selected,
    selectedThreadId,
    onSelect,
    onPrefetch,
    onEdit,
    onNewThread,
    onDelete,
    onDeleteThread,
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
    mentions: number
    needsAttention: boolean
    workingBots: string[]
    selected: boolean
    selectedThreadId: string | null
    onSelect: (id: string) => void
    onPrefetch?: ((id: string) => void) | undefined
    onEdit: (group: BotGroup) => void
    onNewThread: (group: BotGroup) => void
    onDeleteThread?: ((threadId: string, botId: string) => Promise<void>) | undefined
    onDelete?: ((groupId: string) => Promise<void>) | undefined
    locale: Locale
  }) => {
    const [threadMenu, setThreadMenu] = useState<string | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null)
    const [deleteError, setDeleteError] = useState(false)
    const [deleteBusy, setDeleteBusy] = useState(false)
    const confirmDelete = async () => {
      if (!deleteTarget || !onDeleteThread || deleteBusy) return
      setDeleteBusy(true)
      setDeleteError(false)
      try {
        await onDeleteThread(deleteTarget.id, deleteTarget.botId)
        setDeleteTarget(null)
      } catch {
        setDeleteError(true)
      } finally {
        setDeleteBusy(false)
      }
    }
    const [menuOpen, setMenuOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const navigationKey = selected ? selectedThreadId : null
    // biome-ignore lint/correctness/useExhaustiveDependencies: navigating away dismisses the group's actions
    useEffect(() => setMenuOpen(false), [navigationKey])

    const attentionLabel = t("Channel attention count", { count: 1 }, locale)
    const unreadCount = Math.max(0, unread - selectedUnread)
    const unreadLabel = t("Unread messages", { count: unreadCount }, locale)
    const mentionLabel = t("Mentions", { count: mentions }, locale)
    const stateLabels = [
      ...(mentions > 0 ? [mentionLabel] : []),
      ...(needsAttention ? [attentionLabel] : []),
      ...(unreadCount > 0 ? [unreadLabel] : []),
    ]
    const conversations = selected ? getChannelSidebarThreads(threads, group, locale) : []

    return (
      <div className={`group-sidebar-item ${selected ? "selected" : ""}`}>
        <SidebarRow
          onPointerEnter={() => {
            if (firstThreadId) onPrefetch?.(firstThreadId)
          }}
          onFocus={() => {
            if (firstThreadId) onPrefetch?.(firstThreadId)
          }}
          selected={selected}
          rowAttention={needsAttention ? "waiting" : undefined}
          className="group-select"
          rowClassName={unreadCount > 0 || mentions > 0 ? "channel-row has-unread" : "channel-row"}
          ariaLabel={[group.name, ...stateLabels].join(", ")}
          leading={<span className="channel-hash">#</span>}
          label={
            <span className="bot-row-text">
              <span className="bot-row-top">
                <span className="channel-name">{group.name}</span>
                <ChannelWorkingMarker names={workingBots} locale={locale} />
                {time && <small className="bot-row-time">{time}</small>}
              </span>
            </span>
          }
          trailing={
            mentions > 0 ? (
              <SidebarCount count={mentions} label={mentionLabel} tone="mention" />
            ) : needsAttention ? (
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
              <div className="channel-thread-row" key={thread.id}>
                <button
                  type="button"
                  aria-current={thread.id === selectedThreadId ? "page" : undefined}
                  onClick={() => onSelect(thread.id)}
                >
                  {getChannelThreadTitle(thread, locale)}
                </button>
                {onDeleteThread && (
                  <SidebarActionsMenu
                    label={t(
                      "Conversation actions for {title}",
                      { title: getChannelThreadTitle(thread, locale) },
                      locale,
                    )}
                    open={threadMenu === thread.id}
                    onOpenChange={(open) => setThreadMenu(open ? thread.id : null)}
                    actions={[
                      {
                        label: t("Delete conversation…", {}, locale),
                        destructive: true,
                        onSelect: () => {
                          setDeleteTarget(thread)
                          setDeleteError(false)
                        },
                      },
                    ]}
                  />
                )}
              </div>
            ))}
            {deleteTarget && (
              <DeleteThreadDialog
                undoable={false}
                pending={deleteBusy}
                error={deleteError ? t("Could not delete conversation. Try again.", {}, locale) : undefined}
                targets={[
                  { id: deleteTarget.id, title: getChannelThreadTitle(deleteTarget, locale), messageCount: null },
                ]}
                onConfirm={() => {
                  void confirmDelete()
                }}
                onClose={() => {
                  if (!deleteBusy) setDeleteTarget(null)
                }}
              />
            )}
          </div>
        )}
      </div>
    )
  },
)
