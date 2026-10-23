import type { Thread } from "@touri/contracts"
import { getRoutineRunDateLabel, type Locale, t, threadTitle } from "./i18n"
import { markdownSummary } from "./markdownSummary"

export const getRoutineThreadTitle = (
  thread: Pick<Thread, "title" | "createdAt" | "routineTitle">,
  locale: Locale = "pt-BR",
): string => {
  const identity = thread.routineTitle
  if (!identity || thread.title !== identity.sourceTitle)
    return markdownSummary(threadTitle(thread.title, thread.createdAt))

  const date = getRoutineRunDateLabel(identity.scheduledFor, locale, identity.timezone)

  return markdownSummary(t("Routine conversation title", { name: identity.name, date }, locale))
}
