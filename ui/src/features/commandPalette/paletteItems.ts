import type { Bot, Id, Message, Thread } from "@touri/contracts"
import { threadTitle } from "../../i18n"
import { markdownSummary } from "../../markdownSummary"
import { matchScore, normalizeSearch, queryTokens } from "./fuzzy"
import type { PaletteDestination, SettingsIndexEntry } from "./settingsRegistry"

export type PaletteActionId = "new-bot" | "new-group" | "new-thread" | "connect-project" | "open-doctor"

/** Palette commands only navigate or open creation dialogs. Approvals are never commands. */
export type PaletteCommand =
  | { kind: "bot"; botId: Id }
  | { kind: "thread"; threadId: Id }
  | { kind: "setting"; destination: PaletteDestination }
  | { kind: "action"; action: PaletteActionId }

export type PaletteGroupId = "recent" | "bots" | "threads" | "messages" | "settings" | "actions"

export type PaletteItem = {
  id: string
  group: PaletteGroupId
  label: string
  detail: string
  command: PaletteCommand
}

export type PaletteGroup = { id: PaletteGroupId; label: string; items: Array<PaletteItem> }

export const GROUP_LABELS: Record<PaletteGroupId, string> = {
  recent: "Recentes",
  bots: "Bots",
  threads: "Conversas",
  messages: "Mensagens",
  settings: "Configurações",
  actions: "Ações",
}

const GROUP_LIMIT = 8
const MESSAGE_SCAN_LIMIT = 2000

type IndexedItem = PaletteItem & { label_n: string; extra_n: string }

const ACTIONS: ReadonlyArray<{ action: PaletteActionId; label: string; detail: string; keywords: string }> = [
  { action: "new-bot", label: "Novo bot", detail: "Criar um colega", keywords: "criar adicionar colega" },
  { action: "new-group", label: "Novo grupo", detail: "Reunir bots em uma conversa", keywords: "criar equipe" },
  {
    action: "new-thread",
    label: "Nova conversa",
    detail: "Com o bot selecionado",
    keywords: "criar thread chat",
  },
  {
    action: "connect-project",
    label: "Conectar projeto",
    detail: "Pasta ou repositório para o bot",
    keywords: "projetos projeto pasta repositorio git",
  },
  { action: "open-doctor", label: "Abrir Doctor", detail: "Diagnóstico do ambiente", keywords: "diagnostico" },
]

const indexed = (item: PaletteItem, extra: string): IndexedItem => ({
  ...item,
  label_n: normalizeSearch(item.label),
  extra_n: normalizeSearch(`${item.detail} ${extra}`),
})

export type PaletteSource = {
  bots: ReadonlyArray<Bot>
  threads: ReadonlyArray<Thread>
  settings: ReadonlyArray<SettingsIndexEntry>
  hasBot: boolean
}

export type PaletteIndex = { items: Array<IndexedItem>; byId: Map<string, IndexedItem> }

/** Built once per data change; typing only scores the prepared, normalized index. */
export const buildPaletteIndex = ({ bots, threads, settings, hasBot }: PaletteSource): PaletteIndex => {
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]))
  const items: Array<IndexedItem> = [
    ...bots.map((bot) =>
      indexed(
        {
          id: `bot:${bot.id}`,
          group: "bots",
          label: bot.name,
          detail: bot.roleLine || bot.title || "Bot local",
          command: { kind: "bot", botId: bot.id },
        },
        "",
      ),
    ),
    ...[...threads]
      .filter((thread) => botNames.has(thread.botId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) =>
        indexed(
          {
            id: `thread:${thread.id}`,
            group: "threads",
            label: markdownSummary(threadTitle(thread.title, thread.createdAt)),
            detail: botNames.get(thread.botId) ?? "",
            command: { kind: "thread", threadId: thread.id },
          },
          "",
        ),
      ),
    ...settings.map((entry) =>
      indexed(
        {
          id: `settings:${entry.id}`,
          group: "settings",
          label: entry.label,
          detail: entry.detail,
          command: { kind: "setting", destination: entry.destination },
        },
        entry.keywords.join(" "),
      ),
    ),
    ...ACTIONS.filter((action) => action.action !== "new-thread" || hasBot).map((action) =>
      indexed(
        {
          id: `action:${action.action}`,
          group: "actions",
          label: action.label,
          detail: action.detail,
          command: { kind: "action", action: action.action },
        },
        action.keywords,
      ),
    ),
  ]
  return { items, byId: new Map(items.map((item) => [item.id, item])) }
}

const strip = ({ label_n: _label, extra_n: _extra, ...item }: IndexedItem): PaletteItem => item

export type MessageIndex = Array<{ message: Message; thread: Thread; text: string }>

/** Normalizes already-loaded messages once per data change; no transcript is fetched. */
export const buildMessageIndex = (messages: ReadonlyArray<Message>, threads: ReadonlyArray<Thread>): MessageIndex => {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]))
  return [...messages]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MESSAGE_SCAN_LIMIT)
    .flatMap((message) => {
      const thread = threadById.get(message.threadId)
      return thread && message.text ? [{ message, thread, text: normalizeSearch(message.text) }] : []
    })
}

const messageHits = (tokens: ReadonlyArray<string>, messages: MessageIndex): Array<PaletteItem> =>
  messages
    .filter((entry) => tokens.every((token) => entry.text.includes(token)))
    .slice(0, GROUP_LIMIT)
    .map(({ message, thread }) => ({
      id: `message:${message.id}`,
      group: "messages",
      label: markdownSummary(message.text),
      detail: markdownSummary(threadTitle(thread.title, thread.createdAt)),
      command: { kind: "thread", threadId: thread.id },
    }))

const ORDER: ReadonlyArray<PaletteGroupId> = ["bots", "threads", "messages", "settings", "actions"]

export const searchPalette = ({
  index,
  query,
  messages,
  recentIds,
}: {
  index: PaletteIndex
  query: string
  messages: MessageIndex
  recentIds: ReadonlyArray<string>
}): Array<PaletteGroup> => {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return emptyQueryGroups(index, recentIds)
  const scored = index.items
    .map((item) => ({ item, score: matchScore(tokens, { label: item.label_n, extra: item.extra_n }) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  const ranked = ORDER.filter((group) => group !== "messages")
    .map((group) => {
      const entries = scored.filter((entry) => entry.item.group === group)
      return { id: group, top: entries[0]?.score ?? 0, items: entries.slice(0, GROUP_LIMIT).map((e) => strip(e.item)) }
    })
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.top - a.top)
    .map(({ id, items }) => ({ id, label: GROUP_LABELS[id], items }))
  const hits = messageHits(tokens, messages)
  const messageGroup = { id: "messages" as const, label: GROUP_LABELS.messages, items: hits }
  return hits.length > 0 ? [...ranked, messageGroup] : ranked
}

const RECENT_THREADS = 5

const emptyQueryGroups = (index: PaletteIndex, recentIds: ReadonlyArray<string>): Array<PaletteGroup> => {
  const recent = recentIds.flatMap((id) => {
    const item = index.byId.get(id)
    return item ? [{ ...strip(item), id: `recent:${item.id}`, group: "recent" as const }] : []
  })
  const recentSet = new Set(recentIds)
  const threads = index.items
    .filter((item) => item.group === "threads" && !recentSet.has(item.id))
    .slice(0, RECENT_THREADS)
    .map(strip)
  const actions = index.items.filter((item) => item.group === "actions").map(strip)
  return [
    { id: "recent" as const, label: GROUP_LABELS.recent, items: recent },
    { id: "threads" as const, label: "Conversas recentes", items: threads },
    { id: "actions" as const, label: GROUP_LABELS.actions, items: actions },
  ].filter((group) => group.items.length > 0)
}

const RECENT_KEY = "touri.palette.recent.v1"
const RECENT_LIMIT = 6

export const readRecentPaletteIds = (): Array<string> => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

/** Recent entries keep the underlying item id; `recent:` prefixes are display-only. */
export const rememberPaletteItem = (id: string): void => {
  const base = id.startsWith("recent:") ? id.slice("recent:".length) : id
  const baseId = base.startsWith("message:") ? null : base
  if (!baseId) return
  try {
    const next = [baseId, ...readRecentPaletteIds().filter((existing) => existing !== baseId)].slice(0, RECENT_LIMIT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* Storage may be unavailable in an embedded browser. */
  }
}
