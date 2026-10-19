import { expect, test } from "vitest"
import { t } from "./i18n"

test("orphaned group run details are available in pt-BR and English", () => {
  const message = "The group or conversation no longer exists. This turn was not run."

  expect(t(message)).toBe("O grupo ou a conversa não existe mais. Este turno não foi executado.")
  expect(t(message, {}, "en")).toBe(message)
})
