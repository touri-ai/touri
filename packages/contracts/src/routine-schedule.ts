export type RoutineScheduleKey =
  | "Agenda personalizada"
  | "A cada minuto"
  | "A cada {count} minutos"
  | "A cada {count} horas"
  | "A cada hora"
  | "A cada hora, aos {minute} minutos"
  | "Todo dia às {time}"
  | "De segunda a sexta às {time}"
  | "Todo dia {day} do mês às {time}"
  | "Toda semana: {day} às {time}"
  | "domingo"
  | "segunda-feira"
  | "terça-feira"
  | "quarta-feira"
  | "quinta-feira"
  | "sexta-feira"
  | "sábado"
  | "horário de São Paulo"

type ScheduleTranslator = (key: RoutineScheduleKey, params?: Record<string, string | number>) => string

const portuguese: ScheduleTranslator = (key, params = {}) =>
  key.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))

/** Describe common schedules exactly; leave other valid cron forms in the details. */
export const describeRoutineSchedule = (
  expression: string,
  timezone: string,
  t: ScheduleTranslator = portuguese,
): string => {
  const fields = expression.trim().split(/\s+/)
  const [minute = "", hour = "", day, month, weekday] = fields
  const daily = fields.length === 5 && day === "*" && month === "*" && weekday === "*"
  const numeric = (field: string, max: number) => /^\d+$/.test(field) && Number(field) <= max
  let label = t("Agenda personalizada")
  const minutes = /^\*\/(\d+)$/.exec(minute)
  const hours = /^\*\/(\d+)$/.exec(hour)
  if (daily && hour === "*" && (minute === "*" || minute === "*/1")) {
    label = t("A cada minuto")
  } else if (daily && hour === "*" && minutes && Number(minutes[1]) > 0 && 60 % Number(minutes[1]) === 0) {
    label = t("A cada {count} minutos", { count: Number(minutes[1]) })
  } else if (daily && minute === "0" && hours && Number(hours[1]) > 0 && 24 % Number(hours[1]) === 0) {
    label = Number(hours[1]) === 1 ? t("A cada hora") : t("A cada {count} horas", { count: Number(hours[1]) })
  } else if (daily && hour === "*" && numeric(minute, 59)) {
    label = Number(minute) === 0 ? t("A cada hora") : t("A cada hora, aos {minute} minutos", { minute: Number(minute) })
  } else if (fields.length === 5 && numeric(minute, 59) && numeric(hour, 23) && month === "*") {
    const time = `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`
    if (daily) label = t("Todo dia às {time}", { time })
    else if (day === "*" && weekday === "1-5") label = t("De segunda a sexta às {time}", { time })
    else if (day && Number(day) >= 1 && numeric(day, 31) && weekday === "*")
      label = t("Todo dia {day} do mês às {time}", { day: Number(day), time })
    else if (day === "*" && weekday && numeric(weekday, 7)) {
      const weekdays = [
        t("domingo"),
        t("segunda-feira"),
        t("terça-feira"),
        t("quarta-feira"),
        t("quinta-feira"),
        t("sexta-feira"),
        t("sábado"),
        t("domingo"),
      ]
      label = t("Toda semana: {day} às {time}", { day: weekdays[Number(weekday)] ?? "", time })
    }
  }
  const zone = timezone === "America/Sao_Paulo" ? t("horário de São Paulo") : timezone
  return `${label} · ${zone}`
}
