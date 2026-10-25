import { Blob as NodeBlob } from "node:buffer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { getBotEditBody } from "../src/api/botEditBody"

beforeEach(() => vi.stubGlobal("Blob", NodeBlob))
afterEach(() => vi.unstubAllGlobals())

it("yields while escaping a multi-megabyte edit and preserves Unicode and control characters", async () => {
  const instructions = 'Texto fictício 😀\n"\\\u0001'.repeat(140_000)
  const input = { name: "Bot de teste", instructions, paused: false }
  const yields: number[] = []

  const body = await getBotEditBody(input, async () => {
    yields.push(1)
  })

  expect(body).toBeInstanceOf(Blob)
  expect(yields.length).toBeGreaterThan(1)
  expect(JSON.parse(await new Response(body).text())).toEqual(input)
})

it("preserves requests with only instruction text and keeps small edits simple", async () => {
  const input = { instructions: "x".repeat(70_000) }

  const body = await getBotEditBody(input, async () => {})
  const small = await getBotEditBody({ name: "Bot de teste" })

  expect(JSON.parse(await new Response(body).text())).toEqual(input)
  expect(small).toBe('{"name":"Bot de teste"}')
})

it("bounds synchronous byte encoding even when JSON escaping expands the instruction text", async () => {
  const encodedSizes = new Set<number>()
  // Constructor observations are local to this request; existing Blob segments need no text encoding.
  class MeasuredBlob extends NodeBlob {
    constructor(
      parts: ConstructorParameters<typeof NodeBlob>[0] = [],
      options?: ConstructorParameters<typeof NodeBlob>[1],
    ) {
      super(parts, options)
      encodedSizes.add(parts.reduce((size, part) => size + (typeof part === "string" ? part.length : 0), 0))
    }
  }
  vi.stubGlobal("Blob", MeasuredBlob)
  const input = { instructions: "\u0001".repeat(1_000_000) }

  const body = await getBotEditBody(input, async () => {})

  expect(Math.max(...encodedSizes)).toBeLessThan(2 * 1024 * 1024)
  expect(JSON.parse(await new Response(body).text())).toEqual(input)
})
