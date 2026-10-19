import { cleanup, render } from "@testing-library/react"
import { AVATAR_SHAPES } from "@touri/contracts/avatar"
import { afterEach, expect, it, vi } from "vitest"
import { BotAvatar } from "../src/components/BotAvatar"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each(AVATAR_SHAPES)("renders %s without duplicate layer keys", (avatarShape) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)

  render(<BotAvatar bot={{ id: "layer-test", color: "#e8483f", avatarShape }} still />)

  const duplicates = errors.mock.calls.filter(([message]) => String(message).includes("same key"))
  expect(duplicates).toEqual([])
})
