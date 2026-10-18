import type { Thread } from "@touri/contracts"
import { threadTitle } from "./i18n"
import { markdownSummary } from "./markdownSummary"

export const getSidebarThreadTitle = (thread: Pick<Thread, "title" | "createdAt">): string => {
  const localizedTitle = threadTitle(thread.title, thread.createdAt)
  const titleWithoutDate = localizedTitle
    .replace(/ [·•] \d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}),?\s+\d{1,2}:\d{2}\s*[AP]M$/i, "")
    .replace(
      / [·•] \d{1,2} de (?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.?(?: de \d{4})?,?\s+\d{1,2}:\d{2}$/i,
      "",
    )

  return markdownSummary(titleWithoutDate.trim() ? titleWithoutDate : localizedTitle)
}
