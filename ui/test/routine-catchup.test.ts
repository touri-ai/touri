import { expect, it } from "vitest"
import { getRoutineSkipSummary, localizeNotice, t } from "../src/i18n"

it.each([
  [
    "Rotina “Notas QA” não executada: o touri não estava em execução no horário agendado.",
    "Routine “Notas QA” did not run: touri was not running at the scheduled time.",
  ],
  [
    "Rotina “Notas QA” não executada: o atraso ultrapassou a janela de recuperação.",
    "Routine “Notas QA” did not run: the delay exceeded the catch-up window.",
  ],
])("localizes the recorded skip reason: %s", (summary, english) => {
  expect(localizeNotice(summary)).toBe(summary)
  expect(getRoutineSkipSummary(summary, "pt-BR")).toBe(summary)
  expect(getRoutineSkipSummary(summary, "en")).toBe(english)
})

it("preserves user content and labels catch-up without assuming downtime", () => {
  const text = "A rotina das minhas notas"

  expect(localizeNotice(text)).toBe(text)
  expect(getRoutineSkipSummary(text)).toBeUndefined()
  expect(t("Execução de recuperação")).toBe("Execução de recuperação")
  expect(t("Execução de recuperação", {}, "en")).toBe("Catch-up run")
})
