import { expect, test } from "vitest"
import { t } from "../src/i18n"

test("orphaned group run details are available in pt-BR and English", () => {
  const message = "O grupo ou a conversa não existe mais. Este turno não foi executado."

  expect(t(message)).toBe(message)
  expect(t(message, {}, "en")).toBe("The group or conversation no longer exists. This turn was not run.")
  expect(t("O grupo ou a conversa não existe mais", {}, "en")).toBe("The group or conversation no longer exists")
})

test("channel menu copy keeps both languages, interpolation and plurals through English fallback", () => {
  expect(t("Team actions")).toBe("Ações do time")
  expect(t("Team actions", {}, "en")).toBe("Team actions")
  expect(t("Select conversation {title}", { title: "Exemplo" })).toBe("Selecionar conversa Exemplo")
  expect(t("Select conversation {title}", { title: "Example" }, "en")).toBe("Select conversation Example")
  expect(t("Delete {count} conversations", { count: 1 })).toBe("Apagar 1 conversa")
  expect(t("Delete {count} conversations", { count: 1 }, "en")).toBe("Delete 1 conversation")
  expect(t("Delete {count} conversations", { count: 2 }, "en")).toBe("Delete 2 conversations")
})
