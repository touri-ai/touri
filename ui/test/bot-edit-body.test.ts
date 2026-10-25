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
