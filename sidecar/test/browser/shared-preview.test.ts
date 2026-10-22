import { expect, test } from "bun:test"
import { createSharedPreviewSource } from "../../src/browser/shared-preview"

test("ten readers share one capture and reuse only a recent frame", async () => {
  let now = 0
  let captures = 0
  const source = createSharedPreviewSource<string>({ now: () => now })
  const input = {
    target: "tab",
    generation: 1,
    isCurrent: () => true,
    read: async () => {
      captures += 1
      return "synthetic-frame"
    },
  }

  const frames = await Promise.all(Array.from({ length: 10 }, () => source.capture(input)))

  expect(frames).toEqual(Array.from({ length: 10 }, () => "synthetic-frame"))
  expect(captures).toBe(1)
  now = 801
  await source.capture(input)
  expect(captures).toBe(2)
})

test("takeover discards an in-flight public frame even after handback", async () => {
  let generation = 1
  let resolve: (value: string) => void = () => {}
  const pending = new Promise<string>((done) => {
    resolve = done
  })
  const source = createSharedPreviewSource<string>()
  const capture = source.capture({
    target: "tab",
    generation,
    isCurrent: () => generation === 1,
    read: () => pending,
  })

  generation = 3
  resolve("private-frame")

  expect(await capture).toBeNull()
})

test("a changed target never starts a second capture while the first is pending", async () => {
  const source = createSharedPreviewSource<string>()
  let resolve: (value: string) => void = () => {}
  const first = source.capture({
    target: "tab",
    generation: 1,
    isCurrent: () => true,
    read: () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  })
  await Promise.resolve()
  let extraCaptures = 0

  const second = await source.capture({
    target: "tab",
    generation: 2,
    isCurrent: () => true,
    read: async () => {
      extraCaptures += 1
      return "unexpected"
    },
  })
  source.clear()
  resolve("old-frame")

  expect(second).toBeNull()
  expect(extraCaptures).toBe(0)
  expect(await first).toBeNull()
})

test("a new public document refreshes immediately after the previous capture completed", async () => {
  const source = createSharedPreviewSource<string>({ now: () => 1 })
  const before = await source.capture({
    target: "tab",
    generation: 1,
    isCurrent: () => true,
    read: async () => "before",
  })

  const after = await source.capture({ target: "tab", generation: 2, isCurrent: () => true, read: async () => "after" })

  expect(before).toBe("before")
  expect(after).toBe("after")
})
