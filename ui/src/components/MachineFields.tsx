import type { Bot, MachineCapability, MachineState } from "@touri/contracts"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { userFacingError } from "../errors"
import { useIsServerMode } from "../features/server/serverMode"
import { machineStatusLabel, t } from "../i18n"
import { machineStateForDisplay } from "../machineState"
import { hostComputerSupported } from "../platform"
import { SettingsRow, SettingsSwitch } from "./SettingsLayout"

type MachineValues = Pick<Bot, "machine" | "machineIdleMinutes" | "vmProviderLogin" | "hostComputerUse">
export const MachineFields = ({
  values,
  provider,
  cloudConnected = false,
  capability,
  state: rawState,
  onChange,
  onAction,
  activeTurns = false,
  technicalDetails,
  technicalDetailsOpen = false,
}: {
  values: MachineValues
  provider: Bot["provider"]
  cloudConnected?: boolean
  capability?: MachineCapability
  state?: MachineState
  onChange: (patch: Partial<MachineValues>) => void
  onAction?: (reset: boolean, stopTurns?: boolean) => Promise<void>
  activeTurns?: boolean
  technicalDetails?: ReactNode
  technicalDetailsOpen?: boolean
}) => {
  const serverMode = useIsServerMode()
  const state = machineStateForDisplay(rawState)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resetTrigger = useRef<HTMLButtonElement>(null)
  const restartTrigger = useRef<HTMLButtonElement>(null)
  const resetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!confirmReset) return
    resetRef.current?.scrollIntoView?.({ block: "nearest" })
    resetRef.current?.querySelector<HTMLButtonElement>(".button-quiet")?.focus({ preventScroll: true })
  }, [confirmReset])
  const restartRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!confirmRestart) return
    restartRef.current?.scrollIntoView?.({ block: "nearest" })
    restartRef.current?.querySelector<HTMLButtonElement>(".button-quiet")?.focus({ preventScroll: true })
  }, [confirmRestart])
  const action = async (reset: boolean, stopTurns = false) => {
    setBusy(true)
    setError(null)
    try {
      await onAction?.(reset, stopTurns)
      setConfirmReset(false)
      setConfirmRestart(false)
    } catch (error) {
      const message = userFacingError(error)
      if (!reset && !stopTurns && message.includes("Máquina ocupada")) setConfirmRestart(true)
      else setError(message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="machine-settings" aria-label="Computador">
      <h3>Computador</h3>
      <div className="machine-environment-row">
        <div className="machine-environment-copy">
          <label htmlFor="bot-machine">{t("Machine")}</label>
          <p className="field-help">
            {values.machine === "cloud"
              ? t("O runtime inteiro roda na nuvem, com sua chave API e sem depender deste computador.")
              : values.machine === "local"
                ? t(
                    serverMode
                      ? "O bot trabalha no servidor escolhido, sem acessar este aparelho."
                      : "Local machine help",
                  )
                : t("VM machine help")}
          </p>
        </div>
        <div className="machine-environment-control">
          {values.machine === "cloud" && (
            <p className="field-help">
              {t("Runtime inteiro na nuvem · chave API própria · sem acesso ao computador local.")}
            </p>
          )}
          {values.machine === "vm" && (
            <span className={`machine-chip machine-${state?.status ?? "stopped"}`} role="status">
              {machineStatusLabel(state?.status ?? "stopped", state?.pauseReason)}
            </span>
          )}
          <select
            id="bot-machine"
            value={values.machine}
            onChange={(event) =>
              onChange({
                machine: event.target.value as Bot["machine"],
                ...(event.target.value === "cloud" ? { vmProviderLogin: false, hostComputerUse: false } : {}),
              })
            }
          >
            {(cloudConnected || values.machine === "cloud") && (
              <option value="cloud" disabled={provider === "opencode"}>
                {provider === "opencode" ? "Na nuvem — OpenCode ainda indisponível" : "Na nuvem"}
              </option>
            )}
            <option value="local">{t(serverMode ? "Neste servidor" : "Local machine")}</option>
            <option value="vm" disabled={!capability?.available}>
              {t("Isolated Linux VM")}
              {!capability?.available ? ` — ${t("No virtualization on this host")}` : ""}
            </option>
          </select>
        </div>
      </div>
      {values.machine === "vm" && (
        <>
          <label className="machine-idle" htmlFor="machine-idle">
            {t("Stop after idle minutes")}
            <input
              id="machine-idle"
              type="number"
              min={1}
              max={1440}
              value={values.machineIdleMinutes}
              onChange={(event) => onChange({ machineIdleMinutes: Number(event.target.value) })}
            />
          </label>
          <label className="toggle-row" htmlFor="machine-provider-login">
            <span>
              <strong>
                {t("Use provider login in VM", {
                  provider: provider === "opencode" ? "OpenCode" : provider === "codex" ? "Codex" : "Claude",
                })}
              </strong>
              <small>{t("Provider login safety help")}</small>
            </span>
            <SettingsSwitch
              id="machine-provider-login"
              checked={values.vmProviderLogin}
              onChange={(event) => onChange({ vmProviderLogin: event.target.checked })}
            />
          </label>
          {!serverMode && hostComputerSupported && (
            <label className="toggle-row" htmlFor="machine-host-control">
              <span>
                <strong>{t("Allow host computer use")}</strong>
                <small>{t("Host computer use help")}</small>
              </span>
              <SettingsSwitch
                id="machine-host-control"
                checked={values.hostComputerUse}
                onChange={(event) => onChange({ hostComputerUse: event.target.checked })}
              />
            </label>
          )}
          {(state?.error || error) && (
            <p className="warning-callout" role="alert">
              {!error && state?.status !== "error" ? "Erro anterior: " : ""}
              {userFacingError(error ?? state?.error)}
            </p>
          )}
          {onAction && (
            <div className="machine-actions">
              <SettingsRow title="Atualizar o computador do bot" description={t("Atualizar computador ajuda")}>
                <button
                  ref={restartTrigger}
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => (activeTurns ? setConfirmRestart(true) : void action(false))}
                >
                  {busy && !confirmReset ? "Atualizando…" : "Atualizar o computador do Bot"}
                </button>
              </SettingsRow>
              <SettingsRow title="Redefinir o computador do bot" description={t("Redefinir computador ajuda")}>
                <button
                  ref={resetTrigger}
                  type="button"
                  className="button settings-danger-button"
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  {busy && confirmReset ? "Redefinindo…" : "Redefinir"}
                </button>
              </SettingsRow>
            </div>
          )}
          {confirmReset && (
            <div ref={resetRef} className="warning-callout" role="alertdialog" aria-label="Redefinir computador do bot">
              <p>{t("Reset machine confirmation")}</p>
              {activeTurns && <p>Os turnos em andamento deste bot também serão cancelados.</p>}
              <button
                type="button"
                className="button settings-danger-button"
                disabled={busy}
                onClick={() => void action(true, activeTurns)}
              >
                {t("Delete and recreate")}
              </button>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => {
                  setConfirmReset(false)
                  resetTrigger.current?.focus()
                }}
              >
                {t("Cancel")}
              </button>
            </div>
          )}
          {confirmRestart && (
            <div
              ref={restartRef}
              className="warning-callout"
              role="alertdialog"
              aria-label="Parar turnos e reiniciar máquina"
            >
              <p>Há turnos em andamento nesta máquina. Parar todos os turnos deste bot e reiniciar?</p>
              <button
                type="button"
                className="button button-brand"
                disabled={busy}
                onClick={() => void action(false, true)}
              >
                Parar turnos e reiniciar
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={busy}
                onClick={() => {
                  setConfirmRestart(false)
                  restartTrigger.current?.focus()
                }}
              >
                {t("Cancel")}
              </button>
            </div>
          )}
        </>
      )}
      {capability?.available === false && <p className="field-help">{t("Conexão da máquina indisponível")}</p>}
      {(values.machine === "vm" || capability?.reason || technicalDetails) && (
        <details
          className="settings-technical-details"
          ref={(details) => {
            // Validation may open the field without closing it as the user corrects the value.
            if (details && technicalDetailsOpen) details.open = true
          }}
        >
          <summary>{t("Detalhes técnicos")}</summary>
          {!capability?.available && capability?.reason && <p className="field-help">{capability.reason}</p>}
          {values.machine === "vm" && (
            <>
              <p className="field-help">{t("VM machine technical help")}</p>
              <p className="field-help">{t("VM provider login help")}</p>
              <p className="field-help">{t("Computador separado detalhes")}</p>
              {state?.progress && <p className="machine-progress">{state.progress}</p>}
              {state?.connection && (
                <p className="field-help">
                  {state.connection.provider} · {state.memoryMb} MiB · {state.connection.machineId}
                </p>
              )}
            </>
          )}
          {technicalDetails}
        </details>
      )}
    </section>
  )
}
