import type { ApiRoutes } from "@touri/contracts"
import type { ApiRequest } from "../src/api/client"
import type { createMockApi } from "../src/api/mock"

type ReplyApi = ReturnType<typeof createMockApi>
type SentReply = ApiRoutes["POST /threads/:id/messages"]["res"]

export const getReplyNavigationApi = (api: ReplyApi): ReplyApi => ({
  ...api,
  request: (async (route, input, path, transport) => {
    const response = await api.request(route, input, path, transport)
    if (route === "POST /threads/:id/messages") publishReplyWhenFinished(api, response as SentReply)

    return response
  }) as ApiRequest,
})

const publishReplyWhenFinished = (api: ReplyApi, response: SentReply) => {
  const run = response.run
  if (!run?.replyMessageId) return

  // The mock streams replies without publishing the thread leaf that the server sends.
  const unsubscribe = api.subscribe(({ event }) => {
    if (event.type !== "run.updated" || event.run.id !== run.id) return
    if (["queued", "starting", "running"].includes(event.run.status)) return

    unsubscribe()
    void api.request("PATCH /threads/:id", { activeLeafId: run.replyMessageId }, { id: response.message.threadId })
  })
}
