import type { MachineState } from "@touri/contracts"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { MachineStopButton } from "./MachineStopButton"

export const MachineStatus = ({
  machine,
  turnFailed,
  api,
  activeTurns = false,
}: {
  machine: MachineState
  turnFailed: boolean
  api: UiApi
  activeTurns?: boolean
}) => {
  const independent =
    machine.status === "starting" && turnFailed && machine.progress !== "Iniciando serviço de máquinas…"
  const explanation = t("Still preparing its computer…")
  return (
    <div className="machine-turn-status" role="status" aria-live="polite">
      <span className={`machine-chip machine-${machine.status}`}>
        {machine.status === "starting"
          ? independent
            ? explanation
            : t("Preparing the computer…")
          : machine.status === "running"
            ? t("Working on its computer…")
            : t("Waiting for its computer…")}
      </span>
      {(machine.status === "running" || independent) && (
        <MachineStopButton api={api} botId={machine.botId} activeTurns={activeTurns} />
      )}
    </div>
  )
}
