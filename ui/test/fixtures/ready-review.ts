import type { Message } from "@touri/contracts"
import type { ApiRequest, UiApi } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"

export const getReadyReviewFixture = async () => {
  const mock = createMockApi()
  const { group } = await mock.request("POST /groups", { name: "avisos", memberIds: [] })
  const { thread } = await mock.request(
    "POST /groups/:id/threads",
    { title: "Revisão da alteração fictícia" },
    { id: group.id },
  )
  const requestId = `pr-ready:${"a".repeat(64)}`
  const review = mock.notify({
    kind: "notice",
    level: "info",
    botId: null,
    botName: null,
    threadId: thread.id,
    targetPersonId: "owner",
    requestId,
    title: "PR ready",
    body: "A alteração fictícia está pronta para conferir.",
  })
  const historical = mock.notify({
    kind: "notice",
    level: "info",
    botId: null,
    botName: null,
    threadId: thread.id,
    targetPersonId: "owner",
    requestId: `pr-ready:${"b".repeat(64)}`,
    title: "PR ready",
    body: "A revisão fictícia anterior já foi conferida.",
    createdAt: review.createdAt - 60_000,
    resolvedAt: review.createdAt - 30_000,
    resolution: "dismissed",
  })
  const message: Message = {
    id: requestId,
    threadId: thread.id,
    parentId: null,
    role: "assistant",
    kind: "notice",
    status: "complete",
    runId: null,
    text: review.body,
    parts: [{ type: "notice", level: "info", code: "automation_notice", text: review.body }],
    sender: { id: "automation-notices", name: "touri" },
    source: "local",
    createdAt: review.createdAt,
    updatedAt: review.createdAt,
  }
  const request: ApiRequest = async (route, input, params) => {
    const response = await mock.request(route, input, params)
    if (route === "GET /threads/:id/messages" && params?.id === thread.id)
      return { ...response, messages: [message], activeLeafId: message.id }

    return response
  }
  const api: UiApi = { ...mock, request }

  return { api, mock, review, historical, group, thread }
}
