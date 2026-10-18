import type { NotifyInput } from "./types"

/** A standalone final marker is a protocol result; prose and code examples remain readable. */
export const getNotificationBody = ({ kind, body }: Pick<NotifyInput, "kind" | "body">): string => {
  if (kind !== "done" || !/(?:^|\r?\n)\s*NO_NOTIFICATION\s*$/.test(body)) return body

  return "Rotina concluída sem novidades."
}
