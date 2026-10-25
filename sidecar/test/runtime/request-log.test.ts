import { expect, test } from "bun:test"
import { getCompleteJsonlRecords } from "../fakes/jsonl"

test("a request log exposes only complete records while its last append is unfinished", () => {
  const first = { method: "thread/start", params: {} }
  const second = { method: "turn/start", params: { text: "pedido completo ".repeat(10_000) } }
  const prefix = `${JSON.stringify(first)}\n`
  const append = `${JSON.stringify(second)}\n`
  const boundary = Math.floor(append.length / 2)

  const duringWrite = getCompleteJsonlRecords(prefix + append.slice(0, boundary))
  const afterWrite = getCompleteJsonlRecords(prefix + append.slice(0, boundary) + append.slice(boundary))

  expect(duringWrite).toEqual([first])
  expect(afterWrite).toEqual([first, second])
})

test("empty logs and unfinished first records expose no requests", () => {
  expect(getCompleteJsonlRecords("")).toEqual([])
  expect(getCompleteJsonlRecords('{"method":')).toEqual([])
  expect(getCompleteJsonlRecords('{"method":"turn/start"}')).toEqual([])
})

test("a malformed complete record still fails instead of hiding corrupted evidence", () => {
  expect(() => getCompleteJsonlRecords('{"method":\n')).toThrow(SyntaxError)
})
