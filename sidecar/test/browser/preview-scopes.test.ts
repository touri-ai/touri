import { expect, mock, test } from "bun:test"
import { createBrowserPreviewScopes } from "../../src/browser/preview-scopes"

test("a private browser request cannot publish a shared channel frame", async () => {
  const scopes = createBrowserPreviewScopes()
  scopes.set("bot", "private-thread")
  const capture = mock(async () => "private-frame")

  const frame = await scopes.capture({
    botId: "bot",
    canReadThread: (threadId) => threadId === "channel-thread",
    capture,
  })

  expect(frame).toBeNull()
  expect(capture).not.toHaveBeenCalled()
})

test("switching requests discards a frame that was already being captured", async () => {
  const scopes = createBrowserPreviewScopes()
  const capture = Promise.withResolvers<string>()
  scopes.set("bot", "channel-thread")
  const pending = scopes.capture({ botId: "bot", canReadThread: () => true, capture: () => capture.promise })

  scopes.set("bot", "private-thread")
  scopes.set("bot", "channel-thread")
  capture.resolve("frame-from-another-request")

  expect(await pending).toBeNull()
})

test("another bot can work without invalidating an authorized shared frame", async () => {
  const scopes = createBrowserPreviewScopes()
  const capture = Promise.withResolvers<string>()
  scopes.set("bot-a", "channel-thread")
  const pending = scopes.capture({
    botId: "bot-a",
    canReadThread: (threadId) => threadId === "channel-thread",
    capture: () => capture.promise,
  })

  scopes.set("bot-b", "private-thread")
  capture.resolve("authorized-frame")

  expect(await pending).toBe("authorized-frame")
})
