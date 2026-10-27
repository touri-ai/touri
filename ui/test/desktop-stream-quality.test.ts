import { expect, test } from "vitest"
import { getDefaultKeyboardLayout } from "../src/features/desktop/keyboardLayout"
import { getInitialQuality, getStreamQuality } from "../src/features/desktop/streamQuality"

test("system Portuguese selects ABNT2 and other locales select US", () => {
  expect(getDefaultKeyboardLayout(["pt-BR", "en"])).toBe("br")
  expect(getDefaultKeyboardLayout(["en-US"])).toBe("us")
})

test("quality requires sustained throughput, separate thresholds and a hold period", () => {
  const initial = getInitialQuality(0)

  const high = getStreamQuality(initial, 9_000_000, 6_000)
  const held = getStreamQuality(high, 300_000, 8_000)
  const low = getStreamQuality(held, 300_000, 12_000)

  expect(high.quality).toBe(8)
  expect(held.quality).toBe(8)
  expect(low.quality).toBe(6)
  expect(getStreamQuality(high, 200, 14_000).quality).toBe(8)
})

test("layout is remembered separately for each bot", async () => {
  const { getKeyboardLayout, saveKeyboardLayout } = await import("../src/features/desktop/keyboardLayout")

  saveKeyboardLayout("one", "br")
  saveKeyboardLayout("two", "us")

  expect(getKeyboardLayout("one")).toBe("br")
  expect(getKeyboardLayout("two")).toBe("us")
})
