import { expect, test } from "vitest"
import { t } from "../src/i18n"

test("orphaned group run details are available in pt-BR and English", () => {
  const message = "O grupo ou a conversa não existe mais. Este turno não foi executado."

  expect(t(message)).toBe(message)
  expect(t(message, {}, "en")).toBe("The group or conversation no longer exists. This turn was not run.")
  expect(t("O grupo ou a conversa não existe mais", {}, "en")).toBe("The group or conversation no longer exists")
})
