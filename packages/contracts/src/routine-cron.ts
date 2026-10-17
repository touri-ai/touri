import type { Result } from "./types"

type Field = { values: Set<number>; min: number; max: number }

export type CronSpec = { minute: Field; hour: Field; day: Field; month: Field; weekday: Field }

const parseField = ({
  value,
  min,
  max,
}: {
  value: string
  min: number
  max: number
}): Result<{ field: Field }, "INVALID_CRON"> => {
  const values = new Set<number>()
  for (const segment of value.split(",")) {
    const [rangeText, stepText] = segment.split("/")
    if (!rangeText || (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1)))
      return { success: false, errorCode: "INVALID_CRON", error: `Invalid cron field ${value}` }
    const step = stepText === undefined ? 1 : Number(stepText)
    let start = min
    let end = max
    if (rangeText !== "*") {
      const range = rangeText.split("-")
      const first = Number(range[0])
      const last = range.length === 1 ? first : Number(range[1])
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < min || last > max || first > last)
        return { success: false, errorCode: "INVALID_CRON", error: `Invalid cron field ${value}` }
      start = first
      end = last
    }
    for (let current = start; current <= end; current += step) values.add(current)
  }
  if (values.size === 0) return { success: false, errorCode: "INVALID_CRON", error: `Empty cron field ${value}` }
  return { success: true, field: { values, min, max } }
}

export const parseCron = (expression: string): Result<{ cron: CronSpec }, "INVALID_CRON"> => {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return { success: false, errorCode: "INVALID_CRON", error: "Cron must have five fields" }
  const minute = parseField({ value: fields[0] ?? "", min: 0, max: 59 })
  const hour = parseField({ value: fields[1] ?? "", min: 0, max: 23 })
  const day = parseField({ value: fields[2] ?? "", min: 1, max: 31 })
  const month = parseField({ value: fields[3] ?? "", min: 1, max: 12 })
  const weekday = parseField({ value: fields[4] ?? "", min: 0, max: 7 })
  if (!minute.success || !hour.success || !day.success || !month.success || !weekday.success)
    return { success: false, errorCode: "INVALID_CRON", error: "Invalid cron expression" }
  if (weekday.field.values.has(0)) weekday.field.values.add(7)
  const minuteValues = [...minute.field.values].sort((left, right) => left - right)
  if (minuteValues.some((value, index) => index > 0 && value - (minuteValues[index - 1] ?? value) < 5))
    return { success: false, errorCode: "INVALID_CRON", error: "Routine interval must be at least five minutes" }
  return {
    success: true,
    cron: { minute: minute.field, hour: hour.field, day: day.field, month: month.field, weekday: weekday.field },
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

const partsFor = ({
  at,
  timezone,
}: {
  at: number
  timezone: string
}): { minute: number; hour: number; day: number; month: number; weekday: number } => {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    })
    formatters.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(new Date(at))
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const weekdays = new Map(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((value, index) => [value, index]))
  return {
    minute: Number(values.get("minute") ?? 0),
    hour: Number(values.get("hour") ?? 0),
    day: Number(values.get("day") ?? 0),
    month: Number(values.get("month") ?? 0),
    weekday: weekdays.get(values.get("weekday") ?? "Sun") ?? 0,
  }
}

const matches = ({ cron, at, timezone }: { cron: CronSpec; at: number; timezone: string }): boolean => {
  const parts = partsFor({ at, timezone })
  const weekday = parts.weekday === 0 ? 7 : parts.weekday
  return (
    cron.minute.values.has(parts.minute) &&
    cron.hour.values.has(parts.hour) &&
    cron.day.values.has(parts.day) &&
    cron.month.values.has(parts.month) &&
    cron.weekday.values.has(weekday)
  )
}

export const previousCronSlot = ({
  cron,
  timezone,
  at,
}: {
  cron: CronSpec
  timezone: string
  at: number
}): number | null => {
  const start = Math.floor(at / 60_000) * 60_000
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = start - offset * 60_000
    if (matches({ cron, at: candidate, timezone })) return candidate
  }
  return null
}

export const nextCronSlot = ({
  cron,
  timezone,
  at,
}: {
  cron: CronSpec
  timezone: string
  at: number
}): number | null => {
  const start = Math.ceil(at / 60_000) * 60_000
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = start + offset * 60_000
    if (matches({ cron, at: candidate, timezone })) return candidate
  }
  return null
}

export const formatRoutineTitle = ({ name, at, timezone }: { name: string; at: number; timezone: string }): string =>
  `${name} · ${new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(at))}`

export const validTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}
