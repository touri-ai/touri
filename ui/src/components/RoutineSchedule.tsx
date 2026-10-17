import type { Routine } from "@touri/contracts"
import { t } from "../i18n"
import { routineSchedule } from "../routineSchedule"

export const RoutineSchedule = ({ routine }: { routine: Pick<Routine, "cron" | "timezone"> }) => (
  <>
    <small>{routineSchedule(routine.cron, routine.timezone)}</small>
    <details>
      <summary>{t("Detalhes do agendamento")}</summary>
      <small>
        <code>
          {routine.cron} · {routine.timezone}
        </code>
      </small>
    </details>
  </>
)
