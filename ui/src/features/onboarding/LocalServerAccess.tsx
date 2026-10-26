import { useMemo, useState } from "react"
import type { TauriInvoke } from "../../api/client"
import { t } from "../../i18n"
import { createOnboardingRequest } from "./client"

export const LocalServerAccess = ({ invoke }: { invoke: TauriInvoke }) => {
  const request = useMemo(() => createOnboardingRequest(invoke), [invoke])
  const [code, setCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const createCode = async () => {
    setBusy(true)
    setError(false)
    setCode(null)
    try {
      const result = await request("POST /onboarding/pair-code", {})
      setCode(result.code)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" className="button button-quiet" disabled={busy} onClick={() => void createCode()}>
        {t("setup.newCode")}
      </button>
      {code && (
        <div role="status">
          <p>{t("setup.codeExpires")}</p>
          <output className="setup-pair-code">{code}</output>
        </div>
      )}
      {error && <p role="alert">{t("setup.startError")}</p>}
    </div>
  )
}
