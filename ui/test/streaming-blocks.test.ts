import { expect, it } from "vitest"
import { splitStreamingBlocks } from "../src/components/streamingBlocks"

const list = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => `${from + index}. Item ${from + index} com duas frases. Fim.`).join("\n")

it("keeps the complete text when blocks are joined", () => {
  const content = `Intro\n\n${list(60)}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nFim`

  expect(splitStreamingBlocks(content).join("\n")).toBe(content)
})

it("splits a long list every ten items so earlier items stop changing", () => {
  const blocks = splitStreamingBlocks(`Intro\n\n${list(25)}`)

  expect(blocks).toHaveLength(4)
  expect(blocks[1]?.startsWith("1. ")).toBe(true)
  expect(blocks[2]?.startsWith("11. ")).toBe(true)
  expect(blocks[3]?.startsWith("21. ")).toBe(true)
})

it("never splits inside a code fence", () => {
  const content = "```md\n1. a\n\n2. b\n```\n\nDepois"

  expect(splitStreamingBlocks(content)).toEqual(["```md\n1. a\n\n2. b\n```\n", "Depois"])
})

it("keeps an indented continuation with its list item", () => {
  const content = "1. Item\n\n   continuação do item\n2. Outro"

  expect(splitStreamingBlocks(content)).toEqual([content])
})

it("keeps a table in one block", () => {
  const table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"

  expect(splitStreamingBlocks(table)).toEqual([table])
})

it("only a bare fence closes a code block, including one opened inside a list item", () => {
  const content = "```\ncode\n```js\n\nstill code\n```\n\nDepois"
  const listed = "1. ```py\n   x = 1\n\n   y = 2\n   ```\n\nDepois"

  expect(splitStreamingBlocks(content)).toEqual(["```\ncode\n```js\n\nstill code\n```\n", "Depois"])
  expect(splitStreamingBlocks(listed)).toEqual(["1. ```py\n   x = 1\n\n   y = 2\n   ```\n", "Depois"])
})
