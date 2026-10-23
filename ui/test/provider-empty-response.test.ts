import { expect, test } from "vitest"
import { localizeNotice, t } from "../src/i18n"

test("explains an empty provider response in Portuguese and English", () => {
  const message = "O provedor terminou sem responder. Tente de novo."

  expect(localizeNotice(message)).toBe(message)
  expect(t(message, {}, "pt-BR")).toBe(message)
  expect(t(message, {}, "en")).toBe("The provider finished without a response. Try again.")
})
