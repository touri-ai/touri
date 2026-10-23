import type { RecoveryTask } from "@touri/contracts"
import { useState } from "react"
import { errorRecovery } from "../errorRecovery"
import { getInterruptedTaskDateLabel, getRoutineRunDateLabel, t } from "../i18n"
import { Disclosure } from "./Disclosure"
import { ErrorNotice } from "./ErrorNotice"
import { Modal } from "./Modal"
import "./InterruptedTasks.css"

type Props = {
  tasks: RecoveryTask[]
  loading: boolean
  error: unknown
  reload?: () => void
  onClose: () => void
  onReview: (task: RecoveryTask) => void
  onResume: (task: RecoveryTask) => void
  onDismiss: (task: RecoveryTask, acknowledgeKeys: string[]) => Promise<void>
}

export const InterruptedTasks = (props: Props) => (
  <Modal title={t("Interrupted tasks")} onClose={props.onClose} className="interrupted-tasks">
    <InterruptedTasksContent {...props} />
  </Modal>
)

export const InterruptedTasksContent = (props: Props) => {
  const pending = props.tasks.filter((task) => task.notification.resolvedAt === null)
  const history = props.tasks.filter((task) => task.notification.resolvedAt !== null)
  const groups = [...new Set(pending.map((task) => task.notification.botId))].map((botId) => ({
    botId,
    tasks: pending.filter((task) => task.notification.botId === botId),
  }))

  return (
    <div className="interrupted-content">
      <p>{t("Revise o que ficou pendente antes de continuar. O histórico será preservado.")}</p>
      {props.loading && <p role="status">{t("Loading")}</p>}
      {props.error !== null && (
        <div role="alert">
          <ErrorNotice error={props.error} showActions={false} />
          {props.reload && (
            <button type="button" className="text-button" onClick={props.reload}>
              {t("Tentar novamente")}
            </button>
          )}
        </div>
      )}
      {!props.loading && props.error === null && pending.length === 0 && (
        <p>{t("Nenhuma tarefa interrompida pendente.")}</p>
      )}
      {groups.map((group) => (
        <section key={group.botId ?? "touri"} aria-label={group.tasks[0]?.notification.botName ?? "touri"}>
          <h3>{group.tasks[0]?.notification.botName ?? "touri"}</h3>
          <ul className="interrupted-task-list">
            {group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} {...props} />
            ))}
          </ul>
        </section>
      ))}
      {history.length > 0 && (
        <Disclosure className="interrupted-history" summary={`${t("Interrupções resolvidas")} (${history.length})`}>
          <ul className="interrupted-task-list">
            {history.map((task) => (
              <TaskRow key={task.id} task={task} {...props} />
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  )
}

const TaskRow = ({ task, onReview, onResume, onDismiss }: Props & { task: RecoveryTask }) => {
  const [isReviewing, setReviewing] = useState(false)
  const [acknowledgedEffects, setAcknowledgedEffects] = useState<string | null>(null)
  const [isBusy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const keys = [...new Set(task.effects.flatMap((effect) => (effect.acknowledgeKey ? [effect.acknowledgeKey] : [])))]
  const hasUncertainEffects = task.effects.some((effect) => effect.uncertain)
  const effectRevision = JSON.stringify(task.effects)
  const isAcknowledged = acknowledgedEffects === effectRevision
  const isResolved = task.notification.resolvedAt !== null
  const title = getTaskTitle(task)
  const cause = getTaskCause(task)
  const occurredAt = new Date(task.occurredAt)
  const dismiss = async () => {
    if (isBusy || (hasUncertainEffects && !isAcknowledged)) return
    setBusy(true)
    setError(null)
    try {
      await onDismiss(task, keys)
    } catch (reason) {
      setError(reason)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="interrupted-task" data-testid="interrupted-task">
      <strong>{title}</strong>
      <time dateTime={occurredAt.toISOString()} title={getRoutineRunDateLabel(task.occurredAt)}>
        {getInterruptedTaskDateLabel(task.occurredAt)}
      </time>
      <p>{cause}</p>
      <button
        type="button"
        className="text-button"
        aria-expanded={isReviewing}
        onClick={() => setReviewing((current) => !current)}
      >
        {t("Ver ações realizadas")} ({task.effects.length})
      </button>
      {isReviewing && (
        <section aria-label={t("Ações registradas")}>
          {task.effects.length === 0 && (
            <p>{t("Nenhuma ação confirmada no histórico. Confira o estado atual antes de continuar.")}</p>
          )}
          <ul>
            {task.effects.map((effect) => (
              <li key={JSON.stringify(effect)}>
                <code>{effect.description}</code>
                <span>{t(effect.uncertain ? "Resultado incerto" : "Ação registrada")}</span>
              </li>
            ))}
          </ul>
          {task.notification.threadId && (
            <button type="button" className="text-button" onClick={() => onReview(task)}>
              {t("Open conversation")}
            </button>
          )}
        </section>
      )}
      {!isResolved && (
        <>
          {hasUncertainEffects && (
            <label className="interrupted-acknowledgement">
              <input
                type="checkbox"
                checked={isAcknowledged}
                onChange={(event) => setAcknowledgedEffects(event.target.checked ? effectRevision : null)}
                disabled={isBusy}
              />
              <span>{t("Revisei os efeitos incertos e entendo que descartar não desfaz as ações.")}</span>
            </label>
          )}
          <div className="interrupted-actions">
            <button
              type="button"
              className="button button-brand"
              disabled={isBusy || (!task.notification.threadId && !task.routineId)}
              onClick={() => onResume(task)}
            >
              {t("Retomar tarefa")}
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={isBusy || (hasUncertainEffects && !isAcknowledged)}
              onClick={() => void dismiss()}
            >
              {t("Descartar")}
            </button>
          </div>
        </>
      )}
      {error !== null && <ErrorNotice error={error} showActions={false} />}
    </li>
  )
}

const getTaskTitle = (task: RecoveryTask): string => {
  if (task.notification.resolvedAt !== null) return t("Interrupção anterior · resolvida")
  if (task.routineId) return t("Routine failed")
  return t("Interrupted task")
}

const getTaskCause = (task: RecoveryTask): string => {
  if (task.cause === "app_restart") return t("O touri foi reiniciado.")
  return errorRecovery(task.notification.body, { errorClass: task.cause }).message
}
