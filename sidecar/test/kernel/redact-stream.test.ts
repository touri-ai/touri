import { expect, test } from "bun:test"
import { createRedactor, createStreamingRedactor } from "../../src/kernel/redact"

const token = "sk-ant-oat01-0123456789abcdefghijklmnopqrstuvwxyz"

const stream = (deltas: string[]): string => {
  const { addRedactionValue, redact } = createRedactor()
  addRedactionValue(token)
  const redactor = createStreamingRedactor(redact)
  return deltas.map(redactor.push).join("") + redactor.flush()
}

test("an answer ending in a letter that starts a secret keeps its last letter", () => {
  expect(stream(["12h40min12,857", "s"])).toBe("12h40min12,857s")
  expect(stream(["Pronto, são 3 arquivos"])).toBe("Pronto, são 3 arquivos")
  expect(stream(["termina com sk"])).toBe("termina com sk")
})

test("a secret split across deltas is still masked", () => {
  expect(stream(["chave: sk-ant-oat01-0123", "456789abcdefghijklmnopqrstuvwxyz fim"])).toBe("chave: [REDACTED] fim")
})

test("a long unfinished prefix of a secret at the end of the stream stays masked", () => {
  expect(stream(["chave: sk-ant-oat01-0123456789"])).toBe("chave: [REDACTED]")
})

test("a short tail that is more than half of a short secret stays masked", () => {
  const { addRedactionValue, redact } = createRedactor()
  addRedactionValue("abcdef")
  const redactor = createStreamingRedactor(redact)
  expect(redactor.push("valor abcd") + redactor.flush()).toBe("valor [REDACTED]")
})
