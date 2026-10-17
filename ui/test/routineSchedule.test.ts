import { expect, it } from "vitest"
import { type TranslationKey, t } from "../src/i18n"
import { routineSchedule } from "../src/routineSchedule"

it.each([
  ["0 9 * * *", "Todo dia às 09:00"],
  ["5 8 * * *", "Todo dia às 08:05"],
  ["*/5 * * * *", "A cada 5 minutos"],
  ["* * * * *", "A cada minuto"],
  ["*/1 * * * *", "A cada minuto"],
  ["0 */2 * * *", "A cada 2 horas"],
  ["0 */1 * * *", "A cada hora"],
  ["0 * * * *", "A cada hora"],
  ["15 * * * *", "A cada hora, aos 15 minutos"],
  ["0 9 * * 1-5", "De segunda a sexta às 09:00"],
  ["0 9 * * 1", "Toda semana: segunda-feira às 09:00"],
  ["0 9 * * 0", "Toda semana: domingo às 09:00"],
  ["0 9 15 * *", "Todo dia 15 do mês às 09:00"],
  ["*/7 * * * *", "Agenda personalizada"],
  ["0 9 1 1 *", "Agenda personalizada"],
])("F013 describes %s accurately in pt-BR", (cron, label) => {
  expect(routineSchedule(cron, "America/Sao_Paulo")).toBe(`${label} · horário de São Paulo`)
})

it("preserves other timezones instead of claiming São Paulo time", () => {
  expect(routineSchedule("0 9 * * *", "UTC")).toBe("Todo dia às 09:00 · UTC")
})

it.each([
  ["0 9 * * *", "Every day at 09:00"],
  ["*/5 * * * *", "Every 5 minutes"],
  ["* * * * *", "Every minute"],
  ["0 */2 * * *", "Every 2 hours"],
  ["0 * * * *", "Every hour"],
  ["15 * * * *", "Every hour at 15 minutes past"],
  ["0 9 * * 1-5", "Monday to Friday at 09:00"],
  ["0 9 * * 1", "Every week: Monday at 09:00"],
  ["0 9 * * 0", "Every week: Sunday at 09:00"],
  ["0 9 15 * *", "On day 15 of each month at 09:00"],
  ["*/7 * * * *", "Custom schedule"],
])("routine schedule %s is translated to English", (cron, label) => {
  expect(routineSchedule(cron, "America/Sao_Paulo", "en")).toBe(`${label} · São Paulo time`)
})

it.each<[TranslationKey, string]>([
  ["Ativar rotina", "Activate routine"],
  ["Ativar rotina “{name}”", "Activate routine “Resumo”"],
  ["Prévia da instrução", "Instruction preview"],
  ["Tamanho completo: {count} caracteres", "Full length: 8000 characters"],
  ["Detalhes indisponíveis", "Details unavailable"],
  [
    "Não foi possível mostrar os detalhes desta ação. Negue e peça ao bot para solicitar novamente.",
    "Could not show the details of this action. Deny it and ask the bot to request it again.",
  ],
  ["Detalhes do agendamento", "Schedule details"],
  ["terça-feira", "Tuesday"],
  ["quarta-feira", "Wednesday"],
  ["quinta-feira", "Thursday"],
  ["sexta-feira", "Friday"],
  ["sábado", "Saturday"],
  ["Criar cron", "Create routine"],
  ["Editar cron", "Edit routine"],
  ["Salvar cron", "Save routine"],
])("routine review copy %s is available in English", (key, expected) => {
  expect(t(key, { name: "Resumo", count: 8000 }, "en")).toBe(expected)
})
