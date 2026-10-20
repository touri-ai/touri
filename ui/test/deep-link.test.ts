import { expect, test } from "vitest"
import { buildDeepLink, buildWebDeepLink, parseDeepLink } from "../src/deepLink"

test("parses the desktop scheme with bot and thread", () => {
  expect(parseDeepLink("touri://open?bot=bot-1&thread=thread-9")).toEqual({ bot: "bot-1", thread: "thread-9" })
  expect(parseDeepLink("touri://open/?thread=t%201")).toEqual({ bot: null, thread: "t 1" })
})

test("parses web locations and bare query strings", () => {
  expect(parseDeepLink("?bot=a&thread=b")).toEqual({ bot: "a", thread: "b" })
  expect(parseDeepLink("/?bot=a#frag")).toEqual({ bot: "a", thread: null })
  expect(parseDeepLink("https://box.example:8445/?thread=zz")).toEqual({ bot: null, thread: "zz" })
})

test("rejects empty selections, foreign hosts and non-links", () => {
  expect(parseDeepLink("")).toBeNull()
  expect(parseDeepLink("?foo=bar")).toBeNull()
  expect(parseDeepLink("touri://settings?bot=a")).toBeNull()
  expect(parseDeepLink("touri://open")).toBeNull()
  expect(parseDeepLink("touri://open?bot=")).toBeNull()
})

test("buildDeepLink round-trips", () => {
  const link = { bot: "bot x", thread: "t/1" }
  expect(parseDeepLink(buildDeepLink(link))).toEqual(link)
  const notification = { bot: "bot x", thread: "t/1", notificationId: 42 }
  expect(parseDeepLink(buildDeepLink(notification))).toEqual(notification)
  expect(parseDeepLink("touri://open?notification=9007199254740992")).toBeNull()
})

test("web links round-trip while retaining the path, other parameters and fragment", () => {
  const selection = { bot: "bot x", thread: "t/1" }
  const link = buildWebDeepLink(selection, "https://example.test/app/?mode=web&bot=old#chat")
  expect(link).toBe("/app/?mode=web&bot=bot+x&thread=t%2F1#chat")
  expect(parseDeepLink(link)).toEqual(selection)
  expect(buildWebDeepLink({ bot: null, thread: null }, `https://example.test${link}`)).toBe("/app/?mode=web#chat")
})
