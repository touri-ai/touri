import { sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { errorRecovery } from "../errorRecovery"
import { t } from "../i18n"

export const ErrorDetails = ({ code }: { code: string }) => (
  <details className="error-details">
    <summary>{t("Error details")}</summary>
    <code>{sanitizeDiagnostic(code)}</code>
  </details>
)

/** Keep diagnostic codes selectable, behind a disclosure, without losing the explanation. */
export const ErrorText = ({ text, code }: { text: string; code?: string | null | undefined }) => {
  const message = text.replace(/\s*\[?TOURI-E\d{4}\]?/g, "").trim()
  const view = errorRecovery(text)
  const technical = /[{}]|\bat \S+.*:\d+|\b(?:E[A-Z]{3,}|Error:|stack|stderr)\b/.test(message)
  const diagnostic = getErrorDiagnostic(text, code, technical)
  return (
    <>
      <span>
        {technical || view.classified
          ? view.message
          : message || t("Could not complete this action. Please try again.")}
      </span>
      {diagnostic && <ErrorDetails code={diagnostic} />}
    </>
  )
}

const getErrorDiagnostic = (text: string, code: string | null | undefined, technical: boolean): string => {
  const diagnostic = technical ? text.trim() : ""
  const codes = [...new Set([text, code].filter(Boolean).join(" ").match(/TOURI-E\d{4}/g) ?? [])]
  const extraCodes = codes.filter((value) => !diagnostic.includes(value)).join(" · ")

  return [diagnostic, extraCodes].filter(Boolean).join("\n")
}
