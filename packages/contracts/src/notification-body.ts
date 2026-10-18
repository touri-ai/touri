import type { NotifyInput } from "./types"

/** Routine runs can append the marker to commentary; ordinary prose and code examples stay readable. */
export const getNotificationBody = ({
  kind,
  body,
  routine = false,
}: Pick<NotifyInput, "kind" | "body"> & { routine?: boolean }): string => {
  if (kind !== "done") return body

  const hasNoNewsMarker = routine ? /\bNO_NOTIFICATION\s*$/.test(body) : /(?:^|\r?\n)\s*NO_NOTIFICATION\s*$/.test(body)
  if (!hasNoNewsMarker) return body

  return "Rotina concluída sem novidades."
}
