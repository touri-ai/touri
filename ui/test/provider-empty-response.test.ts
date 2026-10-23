import { expect, test } from "vitest"
import { errorRecovery } from "../src/errorRecovery"
import { localizeNotice, t } from "../src/i18n"

test("explains an empty provider response in Portuguese and English", () => {
  const message = "O provedor terminou sem responder. Tente de novo."

  expect(localizeNotice(message)).toBe(message)
  expect(t(message, {}, "pt-BR")).toBe(message)
  expect(t(message, {}, "en")).toBe("The provider finished without a response. Try again.")
})

test.each([
  { locale: "pt-BR" as const, message: "O provedor terminou sem responder. Tente de novo.", retry: "Tentar novamente" },
  { locale: "en" as const, message: "The provider finished without a response. Try again.", retry: "Retry" },
])("shows the empty response explanation and retry action in $locale", ({ locale, message, retry }) => {
  const recovery = errorRecovery("O provedor terminou sem responder. Tente de novo.", {
    locale,
    errorClass: "cli_protocol",
  })

  expect(recovery.message).toBe(message)
  expect(recovery.classified).toBe(true)
  expect(recovery.actions).toEqual([{ kind: "retry", label: retry }])
})

test("empty response wording never bypasses review of recorded actions", () => {
  const recovery = errorRecovery("O provedor terminou sem responder. Tente de novo.", {
    errorClass: "cli_protocol",
    parts: [{ type: "file_change", callId: "write", paths: ["notes.txt"], diff: null }],
  })

  expect(recovery.actions.map((action) => action.kind)).toEqual(["review", "resume"])
})
