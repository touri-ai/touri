import type { Routine } from "@touri/contracts"
import { t } from "../i18n"
import { routineSchedule } from "../routineSchedule"
import { Disclosure } from "./Disclosure"

export const RoutineSchedule = ({ routine }: { routine: Pick<Routine, "cron" | "timezone"> }) => (
  <>
    <small>{routineSchedule(routine.cron, routine.timezone)}</small>
    <Disclosure summary={t("Detalhes do agendamento")}>
      <small>
        <code>
          {routine.cron} · {routine.timezone}
        </code>
      </small>
    </Disclosure>
  </>
)
