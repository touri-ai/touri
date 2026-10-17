import { describeRoutineSchedule } from "@touri/contracts"
import { type Locale, t } from "./i18n"

export const routineSchedule = (expression: string, timezone: string, locale: Locale = "pt-BR"): string => {
  const simple = simpleSchedule(expression)
  if (simple?.frequency === "days" && simple.days.length > 1) {
    const days = [
      "domingo",
      "segunda-feira",
      "terça-feira",
      "quarta-feira",
      "quinta-feira",
      "sexta-feira",
      "sábado",
    ] as const
    const label = t(
      "Toda semana: {day} às {time}",
      {
        day: simple.days.map((day) => t(days[day] ?? "domingo", {}, locale)).join(", "),
        time: simple.time,
      },
      locale,
    )
    const zone = timezone === "America/Sao_Paulo" ? t("horário de São Paulo", {}, locale) : timezone
    return `${label} · ${zone}`
  }
  return describeRoutineSchedule(expression, timezone, (key, params) => t(key, params, locale))
}

export type SimpleSchedule = { frequency: "weekdays" | "daily" | "days"; time: string; days: number[] }

export const simpleSchedule = (expression: string): SimpleSchedule | null => {
  const [minute, hour, day, month, weekday, extra] = expression.trim().split(/\s+/)
  if (extra || day !== "*" || month !== "*" || !/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "")) return null
  if (Number(minute) > 59 || Number(hour) > 23) return null
  const time = `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`
  if (weekday === "*") return { frequency: "daily", time, days: [1, 2, 3, 4, 5] }
  if (weekday === "1-5") return { frequency: "weekdays", time, days: [1, 2, 3, 4, 5] }
  if (!/^[0-7](,[0-7])*$/.test(weekday ?? "")) return null
  return { frequency: "days", time, days: [...new Set((weekday ?? "").split(",").map((day) => Number(day) % 7))] }
}

export const simpleCron = ({ frequency, time, days }: SimpleSchedule): string => {
  const [hour, minute] = time.split(":").map(Number)
  const weekdays = frequency === "daily" ? "*" : frequency === "weekdays" ? "1-5" : [...days].sort().join(",")
  return `${minute} ${hour} * * ${weekdays}`
}
