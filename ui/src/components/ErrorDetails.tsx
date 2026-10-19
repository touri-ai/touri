import { sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { errorRecovery } from "../errorRecovery"
import { t } from "../i18n"
import { Disclosure } from "./Disclosure"

export const ErrorDetails = ({ code }: { code: string }) => (
  <Disclosure className="error-details" summary={t("Error details")}>
    <code>{sanitizeDiagnostic(code)}</code>
  </Disclosure>
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
  const diagnostic = technical ? text.replace(/\s*\[?TOURI-E\d{4}\]?/g, "").trim() : ""
  const errorText = [text, code].filter(Boolean).join(" ")
  const codes = [...new Set(errorText.match(/TOURI-E\d{4}/g) ?? [])]

  // Keep reference codes ahead of the diagnostic's size limit.
  return [codes.join(" · "), diagnostic].filter(Boolean).join("\n")
}
