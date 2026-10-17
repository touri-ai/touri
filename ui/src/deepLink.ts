export type DeepLink = { bot: string | null; thread: string | null }

const TOURI_SCHEME = "touri:"
const TOURI_HOST = "open"

const fromParams = (params: URLSearchParams): DeepLink | null => {
  const bot = params.get("bot")?.trim() || null
  const thread = params.get("thread")?.trim() || null
  return bot === null && thread === null ? null : { bot, thread }
}

/**
 * Parses either the desktop scheme (`touri://open?bot=<id>&thread=<id>`) or a web location
 * (`/?bot=<id>&thread=<id>` or a bare query string). Returns null when nothing is selected.
 */
export const parseDeepLink = (input: string): DeepLink | null => {
  const value = input.trim()
  if (value.startsWith(`${TOURI_SCHEME}//`)) {
    const rest = value.slice(`${TOURI_SCHEME}//`.length)
    const [host = "", query = ""] = rest.split("?", 2)
    return host.replace(/\/$/, "") === TOURI_HOST ? fromParams(new URLSearchParams(query)) : null
  }
  const queryStart = value.indexOf("?")
  if (queryStart < 0) return null
  return fromParams(new URLSearchParams(value.slice(queryStart + 1).split("#")[0]))
}

export const buildDeepLink = ({ bot, thread }: DeepLink): string => {
  const params = new URLSearchParams()
  if (bot) params.set("bot", bot)
  if (thread) params.set("thread", thread)
  return `touri://open?${params.toString()}`
}

/** Keep the web entry point, unrelated query parameters and fragment when changing selection. */
export const buildWebDeepLink = ({ bot, thread }: DeepLink, current: string): string => {
  const url = new URL(current)
  if (bot) url.searchParams.set("bot", bot)
  else url.searchParams.delete("bot")
  if (thread) url.searchParams.set("thread", thread)
  else url.searchParams.delete("thread")
  return `${url.pathname}${url.search}${url.hash}`
}
