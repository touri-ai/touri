import type { MessagePart } from "@touri/contracts"
import { sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { type Locale, t } from "../i18n"
import { Disclosure } from "./Disclosure"
import type { ToolPart } from "./toolPresentation"

export const RecordedActions = ({ parts, locale }: { parts: MessagePart[]; locale: Locale }) => {
  const actions = parts.filter(
    (part): part is ToolPart => part.type === "tool_call" || part.type === "command" || part.type === "file_change",
  )
  if (actions.length === 0)
    return <p>{t("Nenhuma ação confirmada no histórico. Confira o estado atual antes de continuar.", {}, locale)}</p>

  return (
    // biome-ignore lint/a11y/noRedundantRoles: WebKit drops list semantics when list-style is none.
    <ul className="recorded-actions-list" role="list">
      {actions.map((part) => {
        const detail = getRecordedActionDetail(part)
        const label = getRecordedActionLabel(part, detail, locale)
        const summary = isRecordedOutcomeKnown(part) ? label : `${label} · ${t("Resultado incerto", {}, locale)}`

        return (
          <li key={part.callId}>
            <Disclosure summary={summary}>
              <pre>{detail}</pre>
            </Disclosure>
          </li>
        )
      })}
    </ul>
  )
}

const getRecordedActionDetail = (part: ToolPart): string => {
  if (part.type === "command") return sanitizeDiagnostic(part.command)
  if (part.type === "file_change") return sanitizeDiagnostic(part.paths.join(", "))

  return sanitizeDiagnostic(part.summary)
}

const getRecordedActionLabel = (part: ToolPart, detail: string, locale: Locale): string => {
  const preview = detail.length > 120 ? `${detail.slice(0, 119)}…` : detail
  if (part.type === "command") return t("Comando: {command}", { command: preview }, locale)
  if (part.type === "file_change") {
    const succeeded = part.resolution === "succeeded" || (!part.resolution && part.completedOutcome === "succeeded")
    return t(succeeded ? "Arquivo alterado: {paths}" : "Arquivo: {paths}", { paths: preview }, locale)
  }

  return t("Ação: {summary}", { summary: preview }, locale)
}

const isRecordedOutcomeKnown = (part: ToolPart): boolean => {
  if (part.resolution && part.resolution !== "completed_unobserved")
    return part.resolution === "succeeded" || part.resolution === "failed"
  if (part.type === "command") return part.exitCode !== null
  if (part.type === "file_change") return part.completedOutcome !== undefined

  return part.ok !== null
}
