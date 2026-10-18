/** A local stand-in for the Telegram Bot API: queued updates in, recorded calls out. */
export type FakeTelegramCall = { method: string; params: Record<string, unknown> }

export const createFakeTelegram = ({ token, username = "touri_test_bot" }: { token: string; username?: string }) => {
  let responder: ((call: FakeTelegramCall) => Response | Promise<Response> | null) | null = null
  const updates: Array<Record<string, unknown>> = []
  const calls: Array<FakeTelegramCall> = []
  let nextUpdateId = 1
  let messageId = 100
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const [, prefix, method] = new URL(request.url).pathname.split("/")
      if (prefix !== `bot${token}`)
        return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })
      const params = (await request.json().catch(() => ({}))) as Record<string, unknown>
      const call = { method: method ?? "", params }
      calls.push(call)
      const custom = responder?.(call)
      if (custom) return custom
      if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username } })
      if (method === "getUpdates") {
        const offset = Number(params.offset ?? 0)
        const pending = updates.filter((update) => Number(update.update_id) >= offset)
        if (!pending.length) await Bun.sleep(10)
        return Response.json({ ok: true, result: pending })
      }
      if (method === "sendMessage")
        return Response.json({
          ok: true,
          result: { message_id: ++messageId, chat: { id: Number(params.chat_id), type: "private" }, text: params.text },
        })
      return Response.json({ ok: true, result: true })
    },
  })
  const user = (id: number, firstName: string) => ({ id, is_bot: false, first_name: firstName })
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    respond: (handler: typeof responder) => {
      responder = handler
    },
    sent: (method = "sendMessage") => calls.filter((call) => call.method === method),
    message: ({
      from = 42,
      name = "Ana",
      text,
      chatType = "private",
    }: {
      from?: number
      name?: string
      text: string
      chatType?: string
    }) => {
      updates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: ++messageId,
          from: user(from, name),
          chat: { id: chatType === "private" ? from : -1000, type: chatType },
          text,
        },
      })
    },
    tap: ({
      from = 42,
      name = "Ana",
      data,
      chatId = from,
      promptMessageId = messageId,
    }: {
      from?: number
      name?: string
      data: string
      chatId?: number
      promptMessageId?: number
    }) => {
      updates.push({
        update_id: nextUpdateId++,
        callback_query: {
          id: `cb-${nextUpdateId}`,
          from: user(from, name),
          data,
          message: { message_id: promptMessageId, chat: { id: chatId, type: "private" } },
        },
      })
    },
    stop: () => server.stop(true),
  }
}
