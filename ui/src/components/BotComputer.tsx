import type { Bot, MachineState } from "@touri/contracts"
import { useCallback, useContext, useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { computerKillSwitchEvent } from "../computerKillSwitch"
import { CloudComputer } from "../features/cloud/CloudComputer"
import { DesktopPanel } from "../features/desktop/DesktopPanel"
import { VmCapabilityNotice } from "../features/desktop/VmCapabilityNotice"
import { useIsServerMode } from "../features/server/serverMode"
import { localizeNotice, machineStatusLabel, t } from "../i18n"
import { useComputerPresence } from "../machineIntents"
import { machineStateForDisplay } from "../machineState"
import { ErrorNotice } from "./ErrorNotice"
import { FailureActionContext } from "./FailureActionContext"
import { MachineStopButton } from "./MachineStopButton"
import { PanelIcon } from "./PanelIcon"

const LocalBotComputer = ({
  api,
  bot,
  machine: rawMachine,
  paused = false,
  activeTurns = false,
  autoOpen = false,
  expanded = false,
  onExpand,
  onWindow,
  onPermissions,
}: {
  api: UiApi
  bot: Bot
  machine?: MachineState | undefined
  autoOpen?: boolean
  paused?: boolean
  activeTurns?: boolean
  expanded?: boolean
  onExpand?: () => void
  onWindow?: () => Promise<void>
  onPermissions?: () => void
  onChat?: () => void
  onFiles?: () => void
}) => {
  useComputerPresence(api, bot)
  const failureAction = useContext(FailureActionContext)
  const [viewerControl, setViewerControl] = useState(false)
  const machine = machineStateForDisplay(rawMachine)
  const [hostActive, setHostActive] = useState<boolean | null>(null)
  useEffect(
    () =>
      api.subscribe(({ event }) => {
        if (event.type === "computer.state") setHostActive(event.active && event.botId === bot.id)
      }),
    [api, bot.id],
  )
  const [entered, setEntered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [view, setView] = useState<"desktop" | "terminal">("desktop")
  const [command, setCommand] = useState("")
  const [output, setOutput] = useState("")
  const [executing, setExecuting] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const openGeneration = useRef(0)
  const awaitingComputer = useRef(false)
  useEffect(() => {
    const interrupt = () => {
      if (awaitingComputer.current || viewerControl) {
        openGeneration.current += 1
        awaitingComputer.current = false
        setBusy(false)
      }
      setViewerControl(false)
    }
    window.addEventListener(computerKillSwitchEvent, interrupt)
    return () => window.removeEventListener(computerKillSwitchEvent, interrupt)
  }, [viewerControl])
  const status = machine?.status ?? "stopped"
  const preparing = status === "starting"
  const inactivityPaused = status === "stopped" && machine?.pauseReason === "inactivity"
  const controlActive =
    bot.machine === "vm"
      ? viewerControl && entered && status === "running" && view === "desktop" && !paused
      : hostActive === true
  const progress =
    machine?.progress && !/cancelad[oa]|cancell?ed|Turno cancelado/i.test(machine.progress)
      ? localizeNotice(machine.progress)
      : null
  const terminalAllowed = bot.computerUse && bot.access !== "read-only" && !bot.paused
  useEffect(() => {
    if (status === "running" && awaitingComputer.current) {
      setEntered(true)
      setBusy(false)
      setError(null)
      awaitingComputer.current = false
    }
  }, [status])
  const open = useCallback(async () => {
    const generation = ++openGeneration.current
    awaitingComputer.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await api.request("POST /bots/:id/machine/intent", { intent: "computer-open" }, { id: bot.id })
      const responseMachine = machineStateForDisplay(response.machine) ?? response.machine
      if (mounted.current && generation === openGeneration.current) {
        if (responseMachine.status === "running") {
          awaitingComputer.current = false
          setEntered(true)
        } else if (responseMachine.status !== "starting")
          setError(responseMachine.error ?? "O computador ainda não está pronto. Tente novamente após a inicialização.")
      }
    } catch (reason) {
      if (mounted.current && generation === openGeneration.current && awaitingComputer.current) setError(reason)
    } finally {
      if (mounted.current && generation === openGeneration.current) setBusy(false)
    }
  }, [api, bot.id])
  const openingWindow = useRef(false)
  useEffect(() => {
    if (autoOpen && bot.machine === "vm" && !bot.paused && !openingWindow.current) {
      openingWindow.current = true
      void open()
    }
  }, [autoOpen, bot.machine, bot.paused, open])
  const kill = async () => {
    openGeneration.current += 1
    awaitingComputer.current = false
    setBusy(false)
    setError(null)
    // Unmount the viewer immediately, before waiting on the global kill switch.
    setEntered(false)
    setHostActive(false)
    try {
      await api.request("POST /computer/kill", {})
    } catch (reason) {
      if (mounted.current) setError(reason)
    }
  }
  const execute = async () => {
    if (!terminalAllowed || !command.trim() || executing || paused) return
    setExecuting(true)
    setError(null)
    const submitted = command
    try {
      const result = await api.request("POST /bots/:id/machine/shell", { command: submitted }, { id: bot.id })
      if (mounted.current) {
        setOutput(`$ ${submitted}\n${result.stdout}${result.stderr}\nSaída: ${result.code}`)
        setCommand("")
      }
    } catch (reason) {
      if (mounted.current) setError(reason)
    } finally {
      if (mounted.current) setExecuting(false)
    }
  }
  return (
    <section
      className={`bot-computer ${entered && status === "running" ? "computer-entered" : ""}`}
      aria-label={`Computador de ${bot.name}`}
    >
      <div className="computer-summary">
        <div>
          <strong>{bot.machine === "vm" ? "Computador do bot" : "Este computador"}</strong>
          <span
            className={`machine-chip machine-${bot.machine === "vm" ? status : bot.computerUse ? "running" : "stopped"}`}
            role="status"
          >
            {bot.machine === "vm"
              ? machineStatusLabel(status, machine?.pauseReason)
              : hostActive
                ? "Controle em uso"
                : bot.computerUse
                  ? "Controle permitido"
                  : "Controle desativado"}
          </span>
        </div>
        <p aria-live="polite">
          {bot.machine === "vm"
            ? localizeNotice(
                progress ??
                  (inactivityPaused
                    ? "Máquina pausada por inatividade"
                    : status === "running"
                      ? "Seu computador está pronto para entrar."
                      : status === "starting"
                        ? "Preparando o computador…"
                        : status === "error"
                          ? "Não foi possível iniciar o computador."
                          : "Ligue para acessar a área de trabalho do bot."),
              )
            : t(
                "Este bot trabalha no computador local. O controle depende das permissões do sistema e de uma autorização temporária.",
              )}
        </p>
        {status === "error" && machine?.error && (
          <div role="alert">
            <ErrorNotice
              error={machine.error}
              context={{ provider: bot.provider }}
              onAction={(action) =>
                action === "retry"
                  ? open()
                  : failureAction(
                      action === "login"
                        ? { kind: "setting", settingId: "providerLogin", label: "" }
                        : { kind: "doctor", label: "" },
                    )
              }
            />
          </div>
        )}
        {bot.machine === "vm" ? (
          <div className="computer-actions">
            {status === "running" && (
              <MachineStopButton
                api={api}
                botId={bot.id}
                activeTurns={activeTurns}
                onStopped={() => {
                  openGeneration.current += 1
                  awaitingComputer.current = false
                  setBusy(false)
                  setEntered(false)
                  setViewerControl(false)
                }}
              />
            )}
            {(!entered || status !== "running") && (
              <button
                className="button button-brand"
                type="button"
                disabled={busy || preparing || bot.paused || paused}
                onClick={() => void open()}
              >
                {busy
                  ? status === "running"
                    ? "Abrindo computador…"
                    : "Ligando…"
                  : preparing
                    ? "Preparando…"
                    : status === "running"
                      ? t("Acompanhar a tela")
                      : inactivityPaused
                        ? "Ligar"
                        : "Ligar computador"}
              </button>
            )}
            {onExpand && (
              <button className="button button-quiet" type="button" aria-pressed={expanded} onClick={onExpand}>
                {expanded ? "Recolher" : "Expandir"}
              </button>
            )}
            {onWindow && (
              <button className="button button-quiet" type="button" onClick={() => void onWindow().catch(setError)}>
                Abrir em janela
              </button>
            )}
          </div>
        ) : (
          onPermissions && (
            <button className="button button-quiet" type="button" onClick={onPermissions}>
              Permissões do computador
            </button>
          )
        )}
        {bot.paused && <p>Retome o bot nas configurações para ligar o computador.</p>}
      </div>
      {bot.machine === "vm" && (!entered || status !== "running") && <VmCapabilityNotice bot={bot} />}
      {bot.machine === "vm" && (!entered || status !== "running") && (
        <div className={`computer-entry ${preparing || busy ? "computer-entry-preparing" : ""}`}>
          <PanelIcon name="computer" />
          <strong>
            {busy
              ? "Ligando o computador…"
              : preparing
                ? "Preparando…"
                : status === "running"
                  ? "Pronto para entrar"
                  : status === "error"
                    ? "O computador precisa de atenção"
                    : inactivityPaused
                      ? "Máquina pausada por inatividade"
                      : "Sua área de trabalho está em pausa"}
          </strong>
          <p>
            {preparing || busy
              ? "A tela ficará disponível assim que a preparação terminar."
              : status === "running"
                ? "Entre para acompanhar o trabalho do bot."
                : status === "error"
                  ? "Confira o erro acima e tente ligar novamente."
                  : "Ligue o computador para acessar a tela e o terminal da VM."}
          </p>
          {(preparing || busy) && (
            <div className="computer-preparation" role="progressbar" aria-label="Preparação do computador">
              <span />
            </div>
          )}
        </div>
      )}
      <div className="computer-safety">
        <small>
          {bot.machine === "vm"
            ? entered && status === "running" && view === "desktop"
              ? "Interrompe o controle do computador imediatamente."
              : t("Ao assumir, só você usa o teclado e o mouse. A automação do bot continua com a permissão atual.")
            : "Autorização temporária · atalho de emergência ⌃⌥⌘."}
        </small>
        {controlActive && (
          <button className="button button-quiet computer-kill" type="button" onClick={() => void kill()}>
            Interromper controle
          </button>
        )}
      </div>
      {error !== null && (
        <div className="warning-callout" role="alert">
          <ErrorNotice error={error} context={{ provider: bot.provider }} />
        </div>
      )}
      {bot.machine === "vm" && entered && status === "running" && (
        <>
          <fieldset className="computer-subviews">
            <legend className="visually-hidden">Visualização do computador</legend>
            <button
              className="button button-quiet"
              type="button"
              aria-pressed={view === "desktop"}
              onClick={() => setView("desktop")}
            >
              Área de trabalho
            </button>
            <button
              className="button button-quiet"
              type="button"
              aria-pressed={view === "terminal"}
              onClick={() => setView("terminal")}
            >
              Terminal
            </button>
          </fieldset>
          {view === "desktop" ? (
            <DesktopPanel api={api} bot={bot} paused={paused} onControlChange={setViewerControl} />
          ) : (
            <div className="computer-terminal">
              <p>
                {t(
                  "Um comando de cada vez no computador do bot. Limite: 25 s e 64 KB de saída. Pastas e variáveis não ficam salvas.",
                )}
              </p>
              {!terminalAllowed && (
                <p role="status">
                  Habilite controle do computador e acesso de escrita nas permissões do bot para usar o terminal.
                </p>
              )}
              <pre role="log" aria-label="Saída do terminal" aria-live="polite">
                {output || "Nenhum comando executado."}
              </pre>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void execute()
                }}
              >
                <label htmlFor={`shell-${bot.id}`}>Comando na VM</label>
                <input
                  id={`shell-${bot.id}`}
                  maxLength={4096}
                  value={command}
                  disabled={!terminalAllowed || executing || paused}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="pwd"
                  autoComplete="off"
                />
                <button
                  className="button button-brand"
                  type="submit"
                  disabled={!terminalAllowed || !command.trim() || executing || paused}
                >
                  {executing ? "Executando…" : "Executar"}
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export const BotComputer = (props: Parameters<typeof LocalBotComputer>[0]) => {
  const serverMode = useIsServerMode()
  return props.bot.machine === "local" && (serverMode || !("__TAURI_INTERNALS__" in window)) ? (
    <section className="bot-computer" aria-label={`Computador de ${props.bot.name}`}>
      <p role="status">
        {t("Este servidor não tem uma área de trabalho para controlar. Você pode conversar e trabalhar com arquivos.")}
      </p>
      <div className="computer-actions">
        {props.onChat && (
          <button type="button" className="button button-quiet" onClick={props.onChat}>
            {t("Conversar")}
          </button>
        )}
        {props.onFiles && (
          <button type="button" className="button button-quiet" onClick={props.onFiles}>
            {t("Abrir arquivos")}
          </button>
        )}
      </div>
    </section>
  ) : props.bot.machine === "cloud" ? (
    <CloudComputer api={props.api} bot={props.bot} {...(props.machine ? { machine: props.machine } : {})} />
  ) : (
    <LocalBotComputer {...props} />
  )
}
