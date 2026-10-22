import type { Thread } from "@touri/contracts"
import type { Locale } from "./i18n"
import { getSidebarThreadTitle } from "./sidebarThreadTitle"

export const getChannelThreads = (threads: readonly Thread[], groupId: string): Thread[] => {
  const visible = threads.filter((thread) => thread.groupId === groupId && !thread.groupThreadId && !thread.archivedAt)
  const main = visible.reduce<Thread | undefined>(
    (oldest, thread) =>
      !oldest || thread.createdAt < oldest.createdAt || (thread.createdAt === oldest.createdAt && thread.id < oldest.id)
        ? thread
        : oldest,
    undefined,
  )

  return main ? [main].concat(visible.filter((thread) => thread.id !== main.id)) : []
}

export const getChannelThreadTitle = (thread: Thread, locale: Locale = "pt-BR"): string => {
  const title = getSidebarThreadTitle(thread)
  const routine = thread.kind === "routine" || thread.routineRunId || /[·•].*\d{1,2}:\d{2}/.test(thread.title)
  if (!routine) return title
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
    .format(thread.createdAt)
    .replace(/ de |\./g, " ")
    .trim()

  return `${title} · ${date}`
}
