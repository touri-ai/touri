import type { Bot, BotGroup, HostKind, Routine } from "@touri/contracts"
import { nextCronSlot, parseCron, validTimezone } from "@touri/contracts/routine-cron"
import { useEffect, useMemo, useRef, useState } from "react"
import { getHostLabel, t } from "../i18n"
import type { RoutineDraft } from "../routineDraft"
import { routineSchedule, simpleCron, simpleSchedule } from "../routineSchedule"
import type { WorkspaceActions } from "../useWorkspace"
import { DeleteRoutineDialog } from "./DeleteRoutineDialog"
import { Modal } from "./Modal"
import "./routine-editor.css"

const weekdays = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
] as const

const routineTimeZoneLabels = [
  ["America/Sao_Paulo", "Horário de Brasília"],
  ["America/Manaus", "Horário do Amazonas"],
  ["America/Rio_Branco", "Horário do Acre"],
  ["America/Noronha", "Horário de Fernando de Noronha"],
  ["UTC", "UTC"],
] as const

const getRoutineTimeZoneLabel = (timeZone: string) => {
  const knownLabel = routineTimeZoneLabels.find(([zone]) => zone === timeZone)
  if (knownLabel) return t(knownLabel[1])

  try {
    const localizedLabel = new Intl.DateTimeFormat("pt-BR", { timeZone, timeZoneName: "long" })
      .formatToParts(Date.now())
      .find((part) => part.type === "timeZoneName")
    if (localizedLabel) return localizedLabel.value
  } catch {
    return t("Fuso horário inválido")
  }

  return t("Fuso horário inválido")
}

export const routineHostNotice = (host: HostKind) =>
  host === "server"
    ? t("Funciona enquanto o touri estiver em execução no servidor. Você pode fechar esta página.")
    : t("Runs while touri is running on this {host}.", { host: getHostLabel(host) })

export const nextRoutineDates = (cron: string, timezone: string, now: number): number[] => {
  const parsed = parseCron(cron)
  if (!parsed.success || !validTimezone(timezone)) return []
  const dates: number[] = []
  let at = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let index = 0; index < 3; index++) {
    const next = nextCronSlot({ cron: parsed.cron, timezone, at })
    if (next === null) return []
    dates.push(next)
    at = next + 60_000
  }
  return dates
}

export const RoutineEditor = ({
  initial,
  routineId,
  bots,
  groups = [],
  host,
  actions,
  onClose,
}: {
  initial: RoutineDraft
  routineId?: string | undefined
  bots: Bot[]
  groups?: BotGroup[]
  host: HostKind
  actions: Pick<WorkspaceActions, "createRoutine" | "updateRoutine" | "runRoutine" | "deleteRoutine">
  onClose: () => void
}) => {
  const [draft, setDraft] = useState(initial)
  const [savedId, setSavedId] = useState(routineId)
  const [savedName, setSavedName] = useState(initial.name)
  const [deleting, setDeleting] = useState(false)
  const [simple, setSimple] = useState(() => simpleSchedule(initial.cron))
  const [reviewed, setReview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const reviewRef = useRef<HTMLElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState(false)
  const bot = bots.find((bot) => bot.id === draft.botId)
  const botGroups = groups.filter((group) => group.memberIds.includes(draft.botId))
  const group = groups.find((group) => group.id === draft.groupId)
  const signature = JSON.stringify({ draft, bot, group })
  const review = reviewed === signature
  useEffect(() => {
    // Move focus to the reviewed content after the form controls are removed.
    if (review) reviewRef.current?.focus()
    else formRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus()
  }, [review])
  const dates = useMemo(() => nextRoutineDates(draft.cron, draft.timezone, Date.now()), [draft.cron, draft.timezone])
  const valid =
    !!bot &&
    (!draft.groupId || botGroups.some((candidate) => candidate.id === draft.groupId)) &&
    !!draft.name.trim() &&
    draft.name.length <= 80 &&
    !!draft.prompt.trim() &&
    draft.prompt.length <= 8000 &&
    Number.isInteger(draft.timeoutMinutes) &&
    draft.timeoutMinutes >= 1 &&
    draft.timeoutMinutes <= 240 &&
    Number.isInteger(draft.catchUpMinutes) &&
    draft.catchUpMinutes >= 0 &&
    draft.catchUpMinutes <= 1440 &&
    dates.length === 3
  const update = (patch: Partial<RoutineDraft>) => {
    setDraft((draft) => ({ ...draft, ...patch }))
    setReview(null)
    setError(null)
    setTested(false)
  }
  const save = async (activate: boolean) => {
    if (busyRef.current || !valid || !review) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const { botId: _botId, ...fields } = draft
      const patch: Partial<typeof fields> = fields
      // The test run may already have created its dedicated results conversation.
      if (savedId && patch.continuity === "results-thread" && patch.resultsThreadId === null)
        delete patch.resultsThreadId
      const saved: Routine = savedId
        ? await actions.updateRoutine(savedId, { ...patch, enabled: activate })
        : await actions.createRoutine({ ...draft, enabled: activate })
      setSavedId(saved.id)
      setSavedName(saved.name)
      if (activate) onClose()
      else {
        await actions.runRoutine(saved.id)
        setTested(true)
      }
    } catch {
      setError(t("Não foi possível salvar ou iniciar a rotina. Seu rascunho continua aqui. Tente novamente."))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const destination = group
    ? t("Conversa do grupo {group}", { group: group.name })
    : draft.continuity === "new-thread"
      ? bot?.automaticConversationMode === "task"
        ? t("Segue o bot: uma conversa nova por tarefa")
        : t("Segue o bot: conversa principal")
      : draft.continuity === "results-thread"
        ? draft.resultsThreadId
          ? t("Nesta conversa")
          : t("Conversa de resultados")
        : t("Conversa principal")

  return (
    <Modal
      title={review ? t("Revisar rotina") : t("Quando?")}
      onClose={() => {
        if (!busy) onClose()
      }}
      className="routine-editor"
    >
      <form
        ref={formRef}
        onKeyDown={(event) => {
          if (
            (event.key === "Enter" || event.key === " ") &&
            event.target instanceof Element &&
            event.target.closest("[data-routine-consent]")
          ) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <fieldset disabled={busy}>
          <div className="routine-fields">
            {!review ? (
              <>
                <div className="routine-form-grid">
                  <label>
                    {t("Bot")}
                    <select
                      value={draft.botId}
                      disabled={!!savedId}
                      onChange={(event) =>
                        update({
                          botId: event.target.value,
                          resultsThreadId: null,
                          groupId: null,
                          continuity: "main-thread",
                        })
                      }
                    >
                      {bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("Nome")}
                    <input
                      data-initial-focus
                      required
                      maxLength={80}
                      value={draft.name}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </label>
                </div>
                <label>
                  {t("Tarefa")}
                  <textarea
                    required
                    maxLength={8000}
                    rows={3}
                    value={draft.prompt}
                    onChange={(event) => update({ prompt: event.target.value })}
                  />
                </label>
                {simple && (
                  <>
                    <div className="routine-form-grid">
                      <label>
                        {t("Frequência")}
                        <select
                          value={simple.frequency}
                          onChange={(event) => {
                            const next = { ...simple, frequency: event.target.value as typeof simple.frequency }
                            setSimple(next)
                            update({ cron: simpleCron(next) })
                          }}
                        >
                          <option value="weekdays">{t("Dias úteis")}</option>
                          <option value="daily">{t("Todos os dias")}</option>
                          <option value="days">{t("Escolher dias")}</option>
                        </select>
                      </label>
                      <label>
                        {t("Às")}
                        <input
                          type="time"
                          required
                          value={simple.time}
                          onChange={(event) => {
                            const next = { ...simple, time: event.target.value }
                            setSimple(next)
                            update({ cron: simpleCron(next) })
                          }}
                        />
                      </label>
                    </div>
                    {simple.frequency === "days" && (
                      <fieldset className="routine-days">
                        <legend>{t("Dias da semana")}</legend>
                        {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                          <label key={day}>
                            <input
                              type="checkbox"
                              checked={simple.days.includes(day)}
                              onChange={(event) => {
                                const next = {
                                  ...simple,
                                  days: event.target.checked
                                    ? [...simple.days, day]
                                    : simple.days.filter((value) => value !== day),
                                }
                                setSimple(next)
                                update({ cron: simpleCron(next) })
                              }}
                            />
                            {t(weekdays[day] ?? "domingo")}
                          </label>
                        ))}
                      </fieldset>
                    )}
                  </>
                )}
                <label>
                  {t("Fuso horário")}
                  <select value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })}>
                    {[
                      ...new Set([
                        "America/Sao_Paulo",
                        "America/Manaus",
                        "America/Rio_Branco",
                        "America/Noronha",
                        "UTC",
                        draft.timezone,
                      ]),
                    ].map((zone) => (
                      <option key={zone} value={zone}>
                        {getRoutineTimeZoneLabel(zone)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("Destino dos resultados")}
                  <select
                    value={draft.groupId ? `group:${draft.groupId}` : draft.continuity}
                    onChange={(event) => {
                      const groupId = event.target.value.startsWith("group:") ? event.target.value.slice(6) : null
                      if (groupId)
                        update({
                          groupId,
                          continuity: "results-thread",
                          // Keep a conversation of the same group, such as the one the task was scheduled from.
                          resultsThreadId: groupId === initial.groupId ? initial.resultsThreadId : null,
                        })
                      else
                        update({
                          groupId: null,
                          continuity: event.target.value as Routine["continuity"],
                          resultsThreadId: initial.groupId ? null : initial.resultsThreadId,
                        })
                    }}
                  >
                    <option value="main-thread">{t("Conversa principal")}</option>
                    <option value="new-thread">{t("Seguir configuração do bot")}</option>
                    <option value="results-thread">
                      {draft.resultsThreadId && !draft.groupId ? t("Nesta conversa") : t("Conversa de resultados")}
                    </option>
                    {botGroups.map((candidate) => (
                      <option key={candidate.id} value={`group:${candidate.id}`}>
                        {t("Conversa do grupo {group}", { group: candidate.name })}
                      </option>
                    ))}
                  </select>
                </label>
                <details open={!simple}>
                  <summary>{t("Avançado")}</summary>
                  <label>
                    {t("Expressão cron")}
                    <input
                      value={draft.cron}
                      onChange={(event) => {
                        setSimple(simpleSchedule(event.target.value))
                        update({ cron: event.target.value })
                      }}
                    />
                  </label>
                  <label>
                    {t("Fuso IANA")}
                    <input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} />
                  </label>
                  <div className="routine-form-grid">
                    <label>
                      {t("Limite de execução (minutos)")}
                      <input
                        type="number"
                        min={1}
                        max={240}
                        value={draft.timeoutMinutes}
                        onChange={(event) => update({ timeoutMinutes: Number(event.target.value) })}
                      />
                    </label>
                    <label>
                      {t("Recuperar disparos atrasados por (minutos)")}
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={draft.catchUpMinutes}
                        onChange={(event) => update({ catchUpMinutes: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                </details>
              </>
            ) : (
              <section ref={reviewRef} tabIndex={-1} className="routine-review" aria-label={t("Revisar rotina")}>
                <p className="routine-summary">
                  {group
                    ? t("A tarefa {task} será enviada ao grupo {group}, {schedule}.", {
                        task: draft.name,
                        group: group.name,
                        schedule: routineSchedule(draft.cron, draft.timezone).replace(/^De /, "de "),
                      })
                    : t("{bot} fará {task}, {schedule}.", {
                        bot: bot?.name ?? "",
                        task: draft.name,
                        schedule: routineSchedule(draft.cron, draft.timezone).replace(/^De /, "de "),
                      })}
                </p>
                <h3>{t("Tarefa")}</h3>
                <p className="routine-instruction">{draft.prompt}</p>
                <h3>{t("Destino dos resultados")}</h3>
                <p>{destination}</p>
              </section>
            )}
            <section className="routine-context" aria-label={t("Contexto autorizado")}>
              <h3>{t("Contexto autorizado")}</h3>
              {group ? (
                <p>
                  {t(
                    "O grupo recebe a tarefa como uma mensagem sua. Cada membro responde com as próprias permissões; com coordenador, só ele recebe e chama os outros.",
                  )}
                </p>
              ) : (
                <>
                  <p>
                    {draft.continuity === "results-thread" && draft.resultsThreadId
                      ? t("Histórico desta conversa e permissões atuais do bot.")
                      : t("Permissões atuais do bot.")}
                  </p>
                  {bot?.anyFolderAccess ? (
                    <p>{t("Todas as pastas já autorizadas ao bot")}</p>
                  ) : (
                    <ul>
                      {[
                        ...new Set([bot?.cwd, ...(bot?.folders ?? []).map((folder) => folder.path)].filter(Boolean)),
                      ].map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  )}
                  {!bot?.cwd && !bot?.folders?.length && !bot?.anyFolderAccess && (
                    <p>{t("Sem pasta externa autorizada.")}</p>
                  )}
                  {!!bot?.mcpServers?.length && (
                    <p>
                      {t("Fontes")}: {bot.mcpServers.map((server) => server.name).join(", ")}
                    </p>
                  )}
                </>
              )}
              <p>{t("Esta rotina não concede novos acessos. Mudanças de permissões do bot também afetam a rotina.")}</p>
            </section>
            <section aria-label={t("Próximas três execuções")}>
              <h3>{t("Próximas três execuções")}</h3>
              {dates.length ? (
                <ol className="routine-dates">
                  {dates.map((date) => (
                    <li key={date}>
                      <time dateTime={new Date(date).toISOString()}>
                        {new Date(date).toLocaleString("pt-BR", {
                          timeZone: draft.timezone,
                          weekday: "short",
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p role="alert">{t("Escolha dias, hora e fuso válidos para ver as próximas execuções.")}</p>
              )}
              <small>{getRoutineTimeZoneLabel(draft.timezone)}</small>
            </section>
            <p className="routine-form-note">{routineHostNotice(host)}</p>
            {error && <p role="alert">{error}</p>}
            {tested && (
              <p role="status">
                {t("Teste iniciado. O resultado aparecerá no destino escolhido. A rotina continua pausada.")}
              </p>
            )}
          </div>
          <div className="routine-modal-actions">
            <button type="button" className="outline-button" onClick={onClose}>
              {t("Cancelar")}
            </button>
            {review ? (
              <>
                <button type="button" className="outline-button" onClick={() => setReview(null)}>
                  {t("Editar")}
                </button>
                <button
                  type="button"
                  data-routine-consent
                  className="outline-button"
                  disabled={!valid}
                  onClick={() => void save(false)}
                >
                  {t("Testar agora")}
                </button>
                <button
                  type="button"
                  data-routine-consent
                  className="brand-button"
                  disabled={!valid}
                  onClick={() => void save(true)}
                >
                  {t("Ativar rotina")}
                </button>
              </>
            ) : (
              <button type="button" className="brand-button" disabled={!valid} onClick={() => setReview(signature)}>
                {t("Revisar rotina")}
              </button>
            )}
          </div>
          {savedId && (
            <button type="button" className="routine-delete-button" onClick={() => setDeleting(true)}>
              {t("Excluir rotina")}
            </button>
          )}
        </fieldset>
      </form>
      {deleting && savedId && (
        <DeleteRoutineDialog
          routine={{ id: savedId, name: savedName }}
          onDelete={actions.deleteRoutine}
          onClose={() => setDeleting(false)}
          onDeleted={onClose}
        />
      )}
    </Modal>
  )
}
