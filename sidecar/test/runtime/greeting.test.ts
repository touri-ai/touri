import { expect, test } from "bun:test"
import { isConversationTurn, isGreetingTurn } from "../../src/runtime/greeting"

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

test.each(["tudo bem?", "quem é você?", "qual seu nome?", "what do you do?", "Thanks!"])(
  "simple conversation %s uses fast replies",
  (text) => {
    expect(isConversationTurn("user", [{ type: "text", text }], text)).toBe(true)
  },
)

test.each([
  "oi, abra o site",
  "quem é você? execute ls",
  "sim",
  "continue",
  "qual o saldo?",
  "delete files",
  "leia README.md",
])("short task or ambiguous follow-up %s keeps configured effort", (text) => {
  expect(isConversationTurn("user", [{ type: "text", text }], text)).toBe(false)
})

test("simple questions with files and automatic turns do not enter conversation mode", () => {
  expect(isConversationTurn("retry", [{ type: "text", text: "tudo bem?" }], "tudo bem?")).toBe(false)
  expect(
    isConversationTurn(
      "user",
      [{ type: "file", attachmentId: "fixture", name: "notes.txt", mime: "text/plain" }],
      "tudo bem?",
    ),
  ).toBe(false)
})
