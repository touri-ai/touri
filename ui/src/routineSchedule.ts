import { describeRoutineSchedule } from "@touri/contracts"
import { type Locale, t } from "./i18n"

export const routineSchedule = (expression: string, timezone: string, locale: Locale = "pt-BR"): string =>
  describeRoutineSchedule(expression, timezone, (key, params) => t(key, params, locale))
