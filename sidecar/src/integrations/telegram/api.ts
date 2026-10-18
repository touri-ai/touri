/** Minimal Telegram Bot API client. The token lives only in the request URL and never in errors. */
export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(`Telegram API ${status}: ${description}`)
  }
  /** 401 and 404 mean the token is wrong or revoked; retrying will not help. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 404
  }
}

export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export type TelegramChat = { id: number; type: string; first_name?: string; last_name?: string; username?: string }
export type TelegramMessage = { message_id: number; from?: TelegramUser; chat: TelegramChat; text?: string }
export type TelegramCallbackQuery = { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
export type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

export const TELEGRAM_API_BASE = "https://api.telegram.org"

export const createTelegramApi = ({
  token,
  base = TELEGRAM_API_BASE,
  signal: lifetime,
  timeoutMs = 40_000,
}: {
  token: string
  base?: string
  signal?: AbortSignal
  timeoutMs?: number
}) => {
  const call = async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(lifetime ? [lifetime] : []),
      ...(signal ? [signal] : []),
    ])
    try {
      const response = await fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: requestSignal,
      })
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        result?: T
        description?: string
        error_code?: number
        parameters?: { retry_after?: number }
      } | null
      if (!response.ok || !payload?.ok) {
        const retry = payload?.parameters?.retry_after
        const retryAfterSec = typeof retry === "number" && Number.isSafeInteger(retry) && retry >= 0 ? retry : null
        const status = payload?.error_code ?? response.status
        throw new TelegramApiError(
          status,
          (payload?.description ?? `HTTP ${response.status}`).replaceAll(token, "[redacted]"),
          retryAfterSec,
        )
      }
      return payload.result as T
    } catch (error) {
      if (error instanceof TelegramApiError) throw error
      // Fetch and response-body errors can echo the URL, which contains the token.
      throw new TelegramApiError(0, "network error")
    }
  }
  return {
    getMe: (signal?: AbortSignal) => call<TelegramUser>("getMe", {}, signal),
    getUpdates: (params: { offset: number; timeout: number }, signal?: AbortSignal) =>
      call<Array<TelegramUpdate>>("getUpdates", { ...params, allowed_updates: ["message", "callback_query"] }, signal),
    sendMessage: (params: { chat_id: string; text: string; reply_markup?: InlineKeyboard }) =>
      call<TelegramMessage>("sendMessage", params),
    editMessageText: (params: { chat_id: string; message_id: number; text: string; reply_markup?: InlineKeyboard }) =>
      call<TelegramMessage | true>("editMessageText", params),
    sendChatAction: (params: { chat_id: string; action: "typing" }) => call<true>("sendChatAction", params),
    answerCallbackQuery: (params: { callback_query_id: string; text?: string }) =>
      call<true>("answerCallbackQuery", params),
  }
}

export type TelegramApi = ReturnType<typeof createTelegramApi>
