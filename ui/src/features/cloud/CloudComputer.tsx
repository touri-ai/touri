import type { Bot, CloudState, MachineState } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"
import { PanelIcon } from "../../components/PanelIcon"
import { userFacingError } from "../../errors"
import { t } from "../../i18n"
import { DesktopPanel } from "../desktop/DesktopPanel"
import { cloudBytes, cloudHours, useCloudAccount } from "./useCloudAccount"
import "./cloud.css"

const labels: Record<CloudState, string> = {
  absent: "Não criado",
  provisioning: "Criando",
  running: "Rodando",
  parking: "Hibernando",
  hibernated: "Hibernado",
  waking: "Acordando",
  suspended: "Suspenso",
  error: "Erro",
  deleting: "Excluindo",
  deleted: "Excluído",
}
export const CloudComputer = ({ api, bot, machine: initial }: { api: UiApi; bot: Bot; machine?: MachineState }) => {
  const { account } = useCloudAccount(api, true)
  const runtimeAvailable = account?.runtimeAvailable === true
  const [machine, setMachine] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)
  const [command, setCommand] = useState("")
  const [output, setOutput] = useState("")
  useEffect(() => {
    if (initial) setMachine(initial)
  }, [initial])
  useEffect(
    () =>
      api.subscribe(({ event }) => {
        if (event.type === "machine.updated" && event.machine.botId === bot.id) setMachine(event.machine)
      }),
    [api, bot.id],
  )
  const state = machine?.cloud?.state ?? "hibernated"
  const running = state === "running"
  const transition = ["waking", "provisioning", "parking", "deleting"].includes(state)
  const usage = machine?.cloud?.usage
  const action = async (wake: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const value = await api.request(
        wake ? "POST /cloud/bots/:id/wake" : "POST /cloud/bots/:id/park",
        {},
        { id: bot.id },
      )
      setMachine(value.machine)
      if (!wake) setEntered(false)
    } catch (reason) {
      setError(userFacingError(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="bot-computer cloud-computer" aria-label={`Computador na nuvem de ${bot.name}`}>
      <div className="computer-summary">
        <div>
          <strong>Computador na nuvem</strong>
          <span
            className={`machine-chip machine-${running ? "running" : transition ? "starting" : "stopped"}`}
            role="status"
          >
            {labels[state]}
          </span>
        </div>
        <p>
          {runtimeAvailable
            ? t("Seu bot e suas rotinas trabalham mesmo com o computador local desligado.")
            : "Execução na nuvem chega em breve"}
        </p>
        <div className="computer-actions">
          <button
            type="button"
            className="button button-brand"
            disabled={busy || transition || bot.paused || state === "suspended"}
            onClick={() => void action(!running)}
          >
            {busy ? "Aguarde…" : running ? "Hibernar" : "Acordar"}
          </button>
          {running && runtimeAvailable && (
            <button type="button" className="button button-quiet" onClick={() => setEntered(!entered)}>
              {entered ? "Fechar tela" : "Entrar no computador"}
            </button>
          )}
        </div>
      </div>
      {usage && (
        <div className="cloud-usage">
          <div>
            <span>Uso do computador</span>
            <strong>
              {cloudHours(usage.usedSeconds)} <small>/ {cloudHours(usage.includedSeconds)}</small>
            </strong>
            <progress
              aria-label="Horas de nuvem utilizadas"
              value={usage.usedSeconds}
              max={Math.max(1, usage.includedSeconds)}
            />
          </div>
          <div>
            <span>Arquivos persistentes</span>
            <strong>{cloudBytes(usage.storageBytes)}</strong>
            <small>
              Atualizado às{" "}
              {new Date(usage.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </small>
          </div>
        </div>
      )}
      {!entered && (
        <div className="computer-entry">
          <PanelIcon name="computer" />
          <strong>
            {transition
              ? "Preparando seu computador…"
              : running
                ? runtimeAvailable
                  ? "Pronto para entrar"
                  : "Execução na nuvem chega em breve"
                : "Seus arquivos estão guardados"}
          </strong>
          <p>
            {machine?.progress ??
              (running
                ? runtimeAvailable
                  ? "Acompanhe a área de trabalho ou use o terminal."
                  : "Você já pode gerenciar o computador. A execução será disponibilizada em breve."
                : "Acorde para retomar o trabalho. A hibernação preserva os arquivos e libera o computador.")}
          </p>
        </div>
      )}
      {running && runtimeAvailable && entered && <DesktopPanel api={api} bot={bot} />}
      {running && runtimeAvailable && (
        <form
          className="computer-terminal"
          onSubmit={(event) => {
            event.preventDefault()
            if (!command.trim() || busy) return
            setBusy(true)
            void api
              .request("POST /bots/:id/machine/shell", { command }, { id: bot.id })
              .then((value) => {
                setOutput(`${value.stdout}${value.stderr}`)
                setCommand("")
              })
              .catch((reason) => setError(userFacingError(reason)))
              .finally(() => setBusy(false))
          }}
        >
          <label htmlFor={`cloud-shell-${bot.id}`}>Terminal na nuvem</label>
          <input
            id={`cloud-shell-${bot.id}`}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            maxLength={4096}
            disabled={busy || !bot.computerUse || bot.access === "read-only"}
            placeholder="pwd"
          />
          <button
            type="submit"
            className="button button-quiet"
            disabled={busy || !command.trim() || !bot.computerUse || bot.access === "read-only"}
          >
            Executar
          </button>
          {output && <pre role="log">{output}</pre>}
        </form>
      )}
      <p className="field-help">Chave API própria · modelo cobrado pelo seu provedor · sandbox sem cobrança real.</p>
      {error && (
        <p className="warning-callout" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
