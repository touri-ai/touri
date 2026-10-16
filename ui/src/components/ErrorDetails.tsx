import { t } from "../i18n"

const errorCodes = (text: string): string[] => [...new Set(text.match(/TOURI-E\d{4}/g) ?? [])]

export const ErrorDetails = ({ code }: { code: string }) => (
  <details className="error-details">
    <summary>{t("Error details")}</summary>
    <code>{code}</code>
  </details>
)

/** Keep diagnostic codes selectable, behind a disclosure, without losing the explanation. */
export const ErrorText = ({ text, code }: { text: string; code?: string | null | undefined }) => {
  const codes = [...new Set([...errorCodes(text), ...errorCodes(code ?? "")])]
  const message = text.replace(/\s*\[?TOURI-E\d{4}\]?/g, "").trim()
  return (
    <>
      <span>{message || t("Could not complete this action. Please try again.")}</span>
      {codes.length > 0 && <ErrorDetails code={codes.join(" · ")} />}
    </>
  )
}
