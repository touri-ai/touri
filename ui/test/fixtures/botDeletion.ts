import { type ApiRequest, createApiClient } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"

export const getBotDeletionFixture = (outcome: "pending" | "blocked" = "pending", mock = createMockApi()) => {
  const response = Promise.withResolvers<void>()
  const errors = createApiClient({
    endpoint: { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1", token: "test" },
    fetchImpl: async () =>
      Response.json(
        { code: outcome === "blocked" ? "TOURI-E8004" : "TOURI-E2015", error: "private cleanup diagnostic" },
        { status: 409 },
      ),
  })
  const request: ApiRequest = async (route, input, pathValues) => {
    if (route !== "DELETE /bots/:id") return mock.request(route, input, pathValues)
    if (outcome === "blocked") return errors.request(route, input, pathValues)

    // The real route publishes bot.deleted before waiting for attachment collection.
    await mock.request(route, input, pathValues)
    await response.promise

    return errors.request(route, input, pathValues)
  }

  return { api: { ...mock, request }, finishCleanup: () => response.resolve() }
}
