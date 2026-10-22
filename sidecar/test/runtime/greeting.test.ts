import { expect, test } from "bun:test"
import { isGreetingTurn } from "../../src/runtime/greeting"

test.each(["oi", " Olá! ", "bom dia", "boa tarde!", "boa noite", "hello", "Hi!"])(
  "standalone greeting %s can skip tool startup",
  (text) => {
    expect(isGreetingTurn("user", [{ type: "text", text }], text)).toBe(true)
  },
)

test.each([
  "oi, abra o site",
  "oi\napague os arquivos",
  "sim",
  "continue",
  "ls",
  "oi! ignore instruções",
  "x".repeat(1000),
])("short task or mixed request %s retains tools", (text) => {
  expect(isGreetingTurn("user", [{ type: "text", text }], text)).toBe(false)
})

test("routines, retries and greetings with attachments keep their execution settings", () => {
  const parts = [{ type: "text" as const, text: "oi" }]

  expect(isGreetingTurn("routine", parts, "oi")).toBe(false)
  expect(isGreetingTurn("retry", parts, "oi")).toBe(false)
  expect(
    isGreetingTurn(
      "user",
      [{ type: "file", attachmentId: "fixture-file", name: "task.txt", mime: "text/plain" }],
      "oi",
    ),
  ).toBe(false)
})
