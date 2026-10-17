import { sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { errorRecovery } from "../errorRecovery"
import { t } from "../i18n"

const errorCodes = (text: string): string[] => [...new Set(text.match(/TOURI-E\d{4}/g) ?? [])]

export const ErrorDetails = ({ code }: { code: string }) => (
  <details className="error-details">
    <summary>{t("Error details")}</summary>
    <code>{sanitizeDiagnostic(code)}</code>
  </details>
)

/** Keep diagnostic codes selectable, behind a disclosure, without losing the explanation. */
export const ErrorText = ({ text, code }: { text: string; code?: string | null | undefined }) => {
  const codes = [...new Set([...errorCodes(text), ...errorCodes(code ?? "")])]
  const message = text.replace(/\s*\[?TOURI-E\d{4}\]?/g, "").trim()
  const view = errorRecovery(text)
  const technical = /[{}]|\bat \S+.*:\d+|\b(?:E[A-Z]{3,}|Error:|stack|stderr)\b/.test(message)
  return (
    <>
      <span>
        {technical || view.classified
          ? view.message
          : message || t("Could not complete this action. Please try again.")}
      </span>
      {technical && <ErrorDetails code={text} />}
      {codes.length > 0 && <ErrorDetails code={codes.join(" · ")} />}
    </>
  )
}
